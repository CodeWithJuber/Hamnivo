import type {
  ConversationFields,
  ConversationTags,
  CreateSavedReplyRequest,
  CustomFieldDefinition,
  SavedReply,
} from '@hamnivo/contracts';
import { appendAudit, schema, toPublicId } from '@hamnivo/db';
import type {
  AuthorityFieldDefinition,
  AuthorityLabel,
  AuthoritySavedReply,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { uuidV5 } from '../authority/uuid.js';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { CLOCK, type Clock } from '../tokens.js';
import { type ConversationAccess, InboxAccess } from './access.js';
import { InboxMessagesService } from './messages.service.js';
import { InboxSignals } from './signals.service.js';

type FieldValue = string | number | boolean | null;

const VARIABLE = /\{\{\s*([a-zA-Z_]+(?:\.[a-zA-Z_]+)*)\s*\}\}/g;

/** Fills `{{contact.name}}`-style variables (Chatwoot's names); unknown ones are left and listed. */
export function fillVariables(
  content: string,
  values: Record<string, string | null>,
): { preview: string; missing: string[] } {
  const missing = new Set<string>();
  const preview = content.replace(VARIABLE, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    if (value === undefined || value === null || value === '') {
      missing.add(name);
      return whole;
    }
    return value;
  });
  return { preview, missing: [...missing] };
}

/** Checks one custom field value against its definition; returns the value to store. */
export function checkField(
  definition: AuthorityFieldDefinition,
  value: FieldValue,
): { ok: true; value: FieldValue } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null };
  switch (definition.type) {
    case 'checkbox':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: 'Choose yes or no.' };
    case 'number':
    case 'currency':
    case 'percent': {
      const number = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(number) && String(value).trim() !== ''
        ? { ok: true, value: number }
        : { ok: false, message: 'Enter a number.' };
    }
    case 'list':
      return typeof value === 'string' && definition.options.includes(value)
        ? { ok: true, value }
        : { ok: false, message: 'Choose one of the listed values.' };
    case 'date': {
      const text = String(value);
      return /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(text) &&
        Number.isFinite(Date.parse(text))
        ? { ok: true, value: text }
        : { ok: false, message: 'Enter a date like 2026-09-27.' };
    }
    case 'link': {
      try {
        const url = new URL(String(value));
        return url.protocol === 'https:' || url.protocol === 'http:'
          ? { ok: true, value: url.toString() }
          : { ok: false, message: 'Enter a web address.' };
      } catch {
        return { ok: false, message: 'Enter a web address.' };
      }
    }
    default:
      return typeof value === 'string'
        ? { ok: true, value: value.slice(0, 1000) }
        : { ok: false, message: 'Enter text.' };
  }
}

function asFieldValue(value: unknown): FieldValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value).slice(0, 1000);
}

/**
 * Tags and custom fields (H04) and saved replies (H05), in Chatwoot and as the staff member.
 * Only tags and fields the brand defined are accepted: Chatwoot itself would take any tag.
 */
@Injectable()
export class AnnotationsService {
  constructor(
    private readonly access: InboxAccess,
    private readonly messages: InboxMessagesService,
    private readonly signals: InboxSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private load(principal: StaffPrincipal, publicId: string, permission: 'conversations.read') {
    return this.access.tx(principal, (tx) =>
      this.access.authorized(tx, principal, publicId, permission),
    );
  }

  private options(labels: AuthorityLabel[]) {
    return labels.map((l) => ({ title: l.title, description: l.description, color: l.color }));
  }

  async tags(principal: StaffPrincipal, publicId: string): Promise<ConversationTags> {
    const found = await this.load(principal, publicId, 'conversations.read');
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    try {
      const [state, labels] = await Promise.all([
        runtime.authority.getState(String(found.control.externalConversationId), actor),
        runtime.authority.listLabels(actor),
      ]);
      return { labels: state.labels, options: this.options(labels) };
    } catch (error) {
      throw authorityUnavailable(error, 'Tags could not be loaded. Please try again.');
    }
  }

  async setTags(
    principal: StaffPrincipal,
    publicId: string,
    requested: string[],
  ): Promise<ConversationTags> {
    const found = await this.load(principal, publicId, 'conversations.read');
    enforce(this.access.decide(principal, 'conversations.tag', found.resource));
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    const ref = String(found.control.externalConversationId);
    let labels: AuthorityLabel[];
    let current: string[];
    try {
      [labels, { labels: current }] = await Promise.all([
        runtime.authority.listLabels(actor),
        runtime.authority.getState(ref, actor),
      ]);
    } catch (error) {
      throw authorityUnavailable(error, 'Tags could not be changed. Please try again.');
    }
    // Defined tags match without regard to case; tags already on the conversation may stay.
    const known = new Map(labels.map((l) => [l.title.toLowerCase(), l.title]));
    for (const tag of current) if (!known.has(tag.toLowerCase())) known.set(tag.toLowerCase(), tag);
    const unknown = requested.filter((tag) => !known.has(tag.toLowerCase()));
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        fields: unknown.map((tag) => ({ path: 'labels', message: `Unknown tag: ${tag}` })),
      });
    }
    const next = [...new Set(requested.map((tag) => known.get(tag.toLowerCase()) as string))];
    try {
      await runtime.authority.annotate(ref, { labels: next }, actor);
    } catch (error) {
      throw authorityUnavailable(error, 'Tags could not be changed. Please try again.');
    }
    await this.access.tx(principal, async (tx) => {
      await tx
        .insert(schema.conversationInboxState)
        .values({ tenantId: principal.tenantId, conversationId: found.control.id, labels: next })
        .onConflictDoUpdate({
          target: [
            schema.conversationInboxState.tenantId,
            schema.conversationInboxState.conversationId,
          ],
          set: { labels: next, updatedAt: this.clock() },
        });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.tags_changed',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: {
          added: next.filter((t) => !current.includes(t)),
          removed: current.filter((t) => !next.includes(t)),
        },
      });
    });
    await this.signals.changed(principal.tenantId, [found.control.id]);
    return { labels: next, options: this.options(labels) };
  }

  private definitions(definitions: AuthorityFieldDefinition[]): CustomFieldDefinition[] {
    return definitions.map((d) => ({
      key: d.key,
      name: d.name,
      type: d.type,
      description: d.description,
      options: d.options,
    }));
  }

  async fields(principal: StaffPrincipal, publicId: string): Promise<ConversationFields> {
    const found = await this.load(principal, publicId, 'conversations.read');
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    try {
      const [state, definitions] = await Promise.all([
        runtime.authority.getState(String(found.control.externalConversationId), actor),
        runtime.authority.listFieldDefinitions(actor),
      ]);
      return {
        definitions: this.definitions(definitions),
        values: Object.fromEntries(
          definitions
            .filter((d) => d.key in state.attributes)
            .map((d) => [d.key, asFieldValue(state.attributes[d.key])]),
        ),
      };
    } catch (error) {
      throw authorityUnavailable(error, 'Fields could not be loaded. Please try again.');
    }
  }

  async setFields(
    principal: StaffPrincipal,
    publicId: string,
    changes: Record<string, FieldValue>,
  ): Promise<ConversationFields> {
    const found = await this.load(principal, publicId, 'conversations.read');
    enforce(this.access.decide(principal, 'conversations.tag', found.resource));
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    const ref = String(found.control.externalConversationId);
    let definitions: AuthorityFieldDefinition[];
    let attributes: Record<string, unknown>;
    try {
      const [defs, state] = await Promise.all([
        runtime.authority.listFieldDefinitions(actor),
        runtime.authority.getState(ref, actor),
      ]);
      definitions = defs;
      attributes = state.attributes;
    } catch (error) {
      throw authorityUnavailable(error, 'Fields could not be changed. Please try again.');
    }
    const byKey = new Map(definitions.map((d) => [d.key, d]));
    const errors: { path: string; message: string }[] = [];
    const next: Record<string, unknown> = { ...attributes };
    for (const [key, value] of Object.entries(changes)) {
      const definition = byKey.get(key);
      if (!definition) {
        errors.push({ path: `values.${key}`, message: 'This field is not defined.' });
        continue;
      }
      const checked = checkField(definition, value);
      if (!checked.ok) {
        errors.push({ path: `values.${key}`, message: checked.message });
        continue;
      }
      if (checked.value === null) delete next[key];
      else next[key] = checked.value;
    }
    if (errors.length > 0) throw new AppError('VALIDATION_FAILED', { fields: errors });
    // Chatwoot replaces every attribute on write, so the ones not changed (Hamnivo's own too) are
    // sent back as they were.
    try {
      await runtime.authority.annotate(ref, { attributes: next }, actor);
    } catch (error) {
      throw authorityUnavailable(error, 'Fields could not be changed. Please try again.');
    }
    await this.access.tx(principal, (tx) =>
      appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.fields_changed',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: { keys: Object.keys(changes) },
      }),
    );
    await this.signals.changed(principal.tenantId, [found.control.id]);
    return {
      definitions: this.definitions(definitions),
      values: Object.fromEntries(
        definitions.filter((d) => d.key in next).map((d) => [d.key, asFieldValue(next[d.key])]),
      ),
    };
  }

  /** What saved-reply variables stand for in this conversation. */
  private async variables(
    principal: StaffPrincipal,
    found: ConversationAccess,
  ): Promise<Record<string, string | null>> {
    return this.access.tx(principal, async (tx) => {
      const control = found.control;
      const [customer] = control.principalId
        ? await tx
            .select()
            .from(schema.customerPrincipals)
            .where(eq(schema.customerPrincipals.id, control.principalId))
        : [];
      const [me] = await tx
        .select({ name: schema.staffMembers.displayName, email: schema.staffMembers.email })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, principal.staffMemberId));
      const [brand] = control.brandId
        ? await tx
            .select({ name: schema.brands.name })
            .from(schema.brands)
            .where(eq(schema.brands.id, control.brandId))
        : [];
      const contactName = customer?.displayName?.trim() || null;
      const [first, ...rest] = (contactName ?? '').split(/\s+/);
      const [agentFirst, ...agentRest] = (me?.name ?? '').split(/\s+/);
      return {
        'contact.name': contactName,
        'contact.first_name': contactName ? (first ?? null) : null,
        'contact.last_name': contactName && rest.length ? rest.join(' ') : null,
        // Only an address the website verified is ever filled in.
        'contact.email': customer?.emailVerifiedAt ? (customer.email ?? null) : null,
        'agent.name': me?.name ?? null,
        'agent.first_name': agentFirst || null,
        'agent.last_name': agentRest.length ? agentRest.join(' ') : null,
        'inbox.name': brand?.name ?? null,
        'conversation.id': toPublicId('conversation', control.id),
      };
    });
  }

  private view(
    found: ConversationAccess,
    reply: AuthoritySavedReply,
    variables: Record<string, string | null>,
  ): SavedReply {
    const filled = fillVariables(reply.content, variables);
    return {
      id: toPublicId('savedReply', uuidV5(found.control.connectionId, `canned:${reply.ref}`)),
      shortCode: reply.shortCode,
      content: reply.content,
      preview: filled.preview,
      missingVariables: filled.missing,
    };
  }

  async savedReplies(
    principal: StaffPrincipal,
    publicId: string,
    q: string | undefined,
  ): Promise<{ items: SavedReply[] }> {
    const found = await this.load(principal, publicId, 'conversations.read');
    enforce(this.access.decide(principal, 'conversations.reply', found.resource));
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    let replies: AuthoritySavedReply[];
    try {
      replies = await runtime.authority.listSavedReplies(q || undefined, actor);
    } catch (error) {
      throw authorityUnavailable(error, 'Saved replies could not be loaded. Please try again.');
    }
    const variables = await this.variables(principal, found);
    return { items: replies.slice(0, 20).map((r) => this.view(found, r, variables)) };
  }

  /** Adds a saved reply for the brand's whole team (inbox.manage). */
  async createSavedReply(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof CreateSavedReplyRequest>,
  ): Promise<SavedReply> {
    const found = await this.load(principal, publicId, 'conversations.read');
    enforce(this.access.decide(principal, 'inbox.manage', found.resource));
    const { runtime, actor } = await this.messages.actor(principal, found.control);
    let created: AuthoritySavedReply;
    try {
      created = await runtime.authority.createSavedReply(input, actor);
    } catch (error) {
      throw authorityUnavailable(error, 'The saved reply could not be added. Please try again.');
    }
    await this.access.tx(principal, (tx) =>
      appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'inbox.saved_reply_created',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: { shortCode: input.shortCode },
      }),
    );
    return this.view(found, created, await this.variables(principal, found));
  }
}
