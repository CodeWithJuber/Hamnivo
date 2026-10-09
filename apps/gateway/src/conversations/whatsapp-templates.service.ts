import type { TemplateMessage, WhatsappTemplateList } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import {
  type AppendMessageInput,
  channelNameOf,
  invalidValues,
  missingValues,
  renderTemplate,
  replyWindowClosesAt,
  replyWindowOpen,
  templateProcessedParams,
  templateVariables,
  unsupportedReason,
  type WhatsappTemplate,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ControlRow } from '../authority/ownership.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { AppError } from '../common/app-error.js';
import { InboxAccess } from '../inbox/access.js';
import { CLOCK, type Clock } from '../tokens.js';

/** Templates change rarely (Meta reviews each one); a minute saves Chatwoot a call per keystroke. */
const CACHE_MS = 60_000;

interface Listed {
  templates: WhatsappTemplate[];
  lastSyncedAt: Date | null;
}

/** A template checked and ready to send: the text the customer reads and Chatwoot's params. */
export interface PreparedTemplate {
  text: string;
  template: NonNullable<AppendMessageInput['template']>;
}

/**
 * WhatsApp template messages (D14). Chatwoot keeps each WhatsApp inbox's approved templates
 * (synced from Meta); they are read live, so Hamnivo keeps no copy and a template approved in
 * Meta's tools shows here once Chatwoot has synced it.
 */
@Injectable()
export class WhatsappTemplatesService {
  private readonly cache = new Map<string, { at: number; listed: Listed }>();

  constructor(
    private readonly access: InboxAccess,
    private readonly registry: AuthorityRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(principal: StaffPrincipal, publicId: string): Promise<WhatsappTemplateList> {
    const { control, inboxRef } = await this.load(principal, publicId);
    const { templates, lastSyncedAt } = await this.fetch(principal.tenantId, control, inboxRef);
    const now = this.clock();
    return {
      items: templates.map((t) => ({
        name: t.name,
        language: t.language,
        category: t.category,
        header: t.header?.format === 'text' ? t.header.text : null,
        body: t.body,
        footer: t.footer,
        buttons: t.buttons.map((b) => ({ type: b.type, text: b.text })),
        variables: templateVariables(t),
        unsupported: unsupportedReason(t),
      })),
      windowOpen: replyWindowOpen('whatsapp', control.lastCustomerMessageAt, now),
      windowClosesAt:
        replyWindowClosesAt('whatsapp', control.lastCustomerMessageAt)?.toISOString() ?? null,
      lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    };
  }

  /**
   * Checks a template before it is sent: approved, one Hamnivo can send, every value filled and
   * none it does not ask for. A template not in the cached list is looked up again, in case it
   * was approved a moment ago.
   */
  async prepare(
    principal: StaffPrincipal,
    publicId: string,
    request: z.output<typeof TemplateMessage>,
  ): Promise<PreparedTemplate> {
    const { control, inboxRef } = await this.load(principal, publicId);
    const find = (listed: Listed) =>
      listed.templates.find(
        (t) =>
          t.name === request.name && t.language.toLowerCase() === request.language.toLowerCase(),
      );
    const template =
      find(await this.fetch(principal.tenantId, control, inboxRef)) ??
      find(await this.fetch(principal.tenantId, control, inboxRef, true));
    if (!template) {
      throw new AppError('VALIDATION_FAILED', {
        detail:
          'This WhatsApp number has no template with that name and language. Nothing was sent.',
        fields: [{ path: 'template.name', message: 'No such template.' }],
      });
    }
    const unsupported = unsupportedReason(template);
    if (unsupported) {
      throw new AppError('VALIDATION_FAILED', {
        reason: `template_${unsupported}`,
        detail:
          unsupported === 'not_approved'
            ? 'Meta has not approved this template yet. Nothing was sent.'
            : unsupported === 'authentication'
              ? 'One-time-code templates are sent by your own systems, not from the inbox. Nothing was sent.'
              : 'Templates with an image, video or document header cannot be sent from Hamnivo yet. Nothing was sent.',
        fields: [{ path: 'template.name', message: 'This template cannot be sent from here.' }],
      });
    }
    const values = request.values ?? {};
    const missing = missingValues(template, values);
    const invalid = invalidValues(template, values);
    if (missing.length || invalid.length) {
      throw new AppError('VALIDATION_FAILED', {
        detail: missing.length
          ? 'Fill in every value the template asks for. Nothing was sent.'
          : 'Some values do not fit this template. Nothing was sent.',
        fields: [
          ...missing.map((path) => ({ path: `template.values.${path}`, message: 'Fill this in.' })),
          ...invalid.map((path) => ({
            path: `template.values.${path}`,
            message: path.startsWith('buttons.')
              ? 'A code can have at most 15 characters.'
              : 'This template has no such value.',
          })),
        ],
      });
    }
    return {
      text: renderTemplate(template, values),
      template: {
        name: template.name,
        language: template.language,
        category: template.category,
        processedParams: templateProcessedParams(template, values),
      },
    };
  }

  private async load(principal: StaffPrincipal, publicId: string) {
    return this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        publicId,
        'conversations.reply',
      );
      return { control, inboxRef: await whatsappInbox(tx, control) };
    });
  }

  private async fetch(
    tenantId: string,
    control: ControlRow,
    inboxRef: string,
    fresh = false,
  ): Promise<Listed> {
    const key = `${tenantId}:${control.connectionId}:${inboxRef}`;
    const now = this.clock().getTime();
    const cached = this.cache.get(key);
    if (!fresh && cached && now - cached.at < CACHE_MS) return cached.listed;
    const runtime = await this.registry.get(tenantId, control.connectionId);
    const listed = await runtime.authority.listWhatsappTemplates(inboxRef);
    this.cache.set(key, { at: now, listed });
    return listed;
  }
}

/** The Chatwoot inbox of a WhatsApp conversation; anything else has no templates. */
async function whatsappInbox(tx: TenantTx, control: { inboxId: string }): Promise<string> {
  const [inbox] = await tx
    .select({
      channelType: schema.authorityInboxes.channelType,
      externalInboxId: schema.authorityInboxes.externalInboxId,
    })
    .from(schema.authorityInboxes)
    .where(eq(schema.authorityInboxes.id, control.inboxId));
  if (!inbox || channelNameOf(inbox.channelType) !== 'whatsapp') {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Only WhatsApp conversations have template messages.',
    });
  }
  return String(inbox.externalInboxId);
}
