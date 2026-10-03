import {
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { plainText } from '@hamnivo/domain/actions';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { customerView } from '../authority/views.js';
import { InboxAccess, type VisibleScope } from '../inbox/access.js';
import {
  channelOf,
  type InboxRow,
  lastMessages,
  selectRows,
  toInboxConversation,
} from '../inbox/views.js';
import { RetrievalService } from '../knowledge/retrieval.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AuthorityContactsService } from '../widget/contacts.service.js';
import { type McpCaller, mayRead, visibleScope } from './scope.js';

const c = schema.conversationControls;
const st = schema.conversationInboxState;
const p = schema.customerPrincipals;

/** A request the tool cannot do, in words that are safe to give to an outside AI. */
export class McpToolError extends Error {
  override readonly name = 'McpToolError';
  constructor(
    /** `not_found` also covers what exists outside the key's scope: it does not exist for it. */
    readonly code: 'not_found' | 'unavailable' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/** What a tool returns, and what the audit record says about the call. */
export interface ToolResult {
  data: Record<string, unknown>;
  /** How many items came back. */
  count: number;
  target?: { type: 'conversation' | 'customer'; id: string };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Keeps the start of a message around the first match, for search results. */
function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || flat.length <= 200) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 200)}${start + 200 < flat.length ? '…' : ''}`;
}

/** The words for who wrote a message, as the customer sees it. */
const FROM = { customer: 'customer', ai: 'ai_assistant', staff: 'team_member', system: 'system' };
const fromLast = (from: 'customer' | 'ai' | 'staff' | 'system') => FROM[from];

function senderKind(message: AuthorityMessage): 'customer' | 'ai_assistant' | 'team_member' | null {
  switch (message.sender.kind) {
    case 'contact':
      return 'customer';
    case 'bot':
      return 'ai_assistant';
    case 'user':
      return 'team_member';
    default:
      return null;
  }
}

/**
 * What Hamnivo's MCP server reads (read only). Everything is checked against the key's own scope
 * first, so what lies outside it does not exist for the caller, and nothing private reaches an
 * outside AI: transcripts are the customer's own view of a conversation (no private notes, no
 * activity), searches skip private notes, a customer is named and never given an address or
 * number, and memory follows the customer's consent and what each memory may be used for.
 */
@Injectable()
export class McpData {
  private readonly logger = new Logger(McpData.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly contacts: AuthorityContactsService,
    private readonly retrieval: RetrievalService,
  ) {}

  private tx<T>(caller: McpCaller, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: caller.tenantId, actorId: toPublicId('apiKey', caller.keyId) },
      work,
    );
  }

  private scope(caller: McpCaller): VisibleScope {
    const scope = visibleScope(caller.principal, this.clock());
    if (!scope) throw new McpToolError('not_found', 'This key does not reach anything.');
    return scope;
  }

  private conversationRef(value: string): string {
    try {
      return fromPublicId('conversation', value);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) {
        throw new McpToolError('not_found', 'No conversation with this id is available.');
      }
      throw error;
    }
  }

  /** One conversation as a row, when the key's scope reaches it. */
  private async inboxRow(
    tx: TenantTx,
    scope: VisibleScope,
    internalId: string,
  ): Promise<InboxRow | null> {
    const [row] = await selectRows(tx).where(
      and(InboxAccess.condition(scope), eq(c.id, internalId)),
    );
    return row ?? null;
  }

  private summary(row: InboxRow, last: Awaited<ReturnType<typeof lastMessages>>) {
    const view = toInboxConversation(row, last.get(row.control.id));
    return {
      conversationId: view.id,
      brand: view.brand?.name ?? null,
      channel: view.channel,
      status: view.customerStatus,
      customer: { name: view.customer.displayName, identity: view.customer.identity },
      startedAt: view.createdAt,
      lastActivityAt: view.lastActivityAt,
      lastMessage: view.lastMessage
        ? {
            from: fromLast(view.lastMessage.from),
            text: plainText(view.lastMessage.preview, 200),
            at: view.lastMessage.at,
          }
        : null,
    };
  }

  // ── search_conversations ───────────────────────────────────────────────────────────

  async searchConversations(
    caller: McpCaller,
    input: { query: string; limit: number },
  ): Promise<ToolResult> {
    const scope = this.scope(caller);
    const q = input.query.trim();
    const like = `%${escapeLike(q)}%`;
    let byId: string | null = null;
    if (q.startsWith('conv_')) {
      try {
        byId = fromPublicId('conversation', q);
      } catch (error) {
        if (!(error instanceof InvalidPublicIdError)) throw error;
      }
    }
    const found = await this.tx(caller, async (tx) => {
      const rows = await selectRows(tx)
        .where(
          and(
            InboxAccess.condition(scope),
            or(ilike(p.displayName, like), byId ? eq(c.id, byId) : undefined),
          ),
        )
        .orderBy(desc(c.lastActivityAt))
        .limit(input.limit);
      const connections = await tx
        .selectDistinct({ id: c.connectionId })
        .from(c)
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        .leftJoin(st, eq(st.conversationId, c.id))
        .where(InboxAccess.condition(scope));
      return { rows, connections: connections.map((row) => row.id) };
    });

    // What was said: the authority's message search, as the integration user. Private notes and
    // activity are dropped here, so only what a customer could see is ever matched or quoted.
    const hits: { connectionId: string; message: AuthorityMessage }[] = [];
    let searched = true;
    for (const connectionId of found.connections.slice(0, 10)) {
      try {
        const runtime = await this.registry.get(caller.tenantId, connectionId);
        const messages = await runtime.authority.searchMessages(q, 1, { kind: 'integration' });
        for (const message of messages) {
          if (message.private || message.direction === 'activity' || !message.text?.trim())
            continue;
          hits.push({ connectionId, message });
        }
      } catch (error) {
        searched = false;
        this.logger.warn(`message search unavailable: ${String(error)}`);
      }
    }
    const matches = new Map<string, { at: string; from: string | null; snippet: string }[]>();
    const textHits = await this.tx(caller, async (tx) => {
      if (hits.length === 0) return [];
      const rows = await tx
        .select({ id: c.id, connectionId: c.connectionId, external: c.externalConversationId })
        .from(c)
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        .leftJoin(st, eq(st.conversationId, c.id))
        .where(
          and(
            InboxAccess.condition(scope),
            or(
              ...hits.map((h) =>
                and(
                  eq(c.connectionId, h.connectionId),
                  eq(c.externalConversationId, Number(h.message.conversationRef)),
                ),
              ),
            ),
          ),
        );
      return rows;
    });
    const idOf = new Map(textHits.map((r) => [`${r.connectionId}:${r.external}`, r.id]));
    for (const hit of hits) {
      const id = idOf.get(`${hit.connectionId}:${hit.message.conversationRef}`);
      if (!id) continue;
      const list = matches.get(id) ?? [];
      if (list.length < 3) {
        list.push({
          at: hit.message.createdAt.toISOString(),
          from: senderKind(hit.message),
          snippet: plainText(snippet(hit.message.text ?? '', q), 300),
        });
      }
      matches.set(id, list);
    }

    const ids = [...new Set([...matches.keys(), ...found.rows.map((r) => r.control.id)])].slice(
      0,
      input.limit,
    );
    const rows = ids.length
      ? await this.tx(caller, async (tx) => {
          const list = await selectRows(tx)
            .where(and(InboxAccess.condition(scope), inArray(c.id, ids)))
            .orderBy(desc(c.lastActivityAt));
          return { list, last: await lastMessages(tx, ids) };
        })
      : { list: [] as InboxRow[], last: new Map() };
    const conversations = rows.list.map((row) => ({
      ...this.summary(row, rows.last),
      matches: matches.get(row.control.id) ?? [],
    }));
    return {
      data: {
        conversations,
        ...(searched
          ? {}
          : {
              note: 'The text of messages could not be searched just now; only customer names and conversation ids were.',
            }),
      },
      count: conversations.length,
    };
  }

  // ── get_transcript ─────────────────────────────────────────────────────────────────

  async transcript(
    caller: McpCaller,
    input: { conversationId: string; limit: number },
  ): Promise<ToolResult> {
    const scope = this.scope(caller);
    const internalId = this.conversationRef(input.conversationId);
    const loaded = await this.tx(caller, async (tx) => {
      const row = await this.inboxRow(tx, scope, internalId);
      if (!row) return null;
      const control = row.control;
      if (!control.principalId) return { row, contact: null, last: new Map() };
      const [contact] = await tx
        .select({ contact: schema.authorityContacts, inbox: schema.authorityInboxes })
        .from(schema.authorityContacts)
        .innerJoin(
          schema.authorityInboxes,
          eq(schema.authorityInboxes.id, schema.authorityContacts.inboxId),
        )
        .where(
          and(
            eq(schema.authorityContacts.inboxId, control.inboxId),
            eq(schema.authorityContacts.principalId, control.principalId),
          ),
        );
      return { row, contact: contact ?? null, last: await lastMessages(tx, [control.id]) };
    });
    if (!loaded) throw new McpToolError('not_found', 'No conversation with this id is available.');
    const { row, contact } = loaded;
    if (!contact) {
      throw new McpToolError(
        'unavailable',
        'This conversation has no customer view to read, so there is no transcript.',
      );
    }
    const control = row.control;
    let messages: AuthorityMessage[];
    try {
      const runtime = await this.registry.get(caller.tenantId, control.connectionId);
      messages = await runtime.authority.listMessages(String(control.externalConversationId), {
        view: 'customer',
        contactSourceId: this.contacts.sourceIdOf(caller.tenantId, contact.contact),
        inboxRef: String(contact.inbox.externalInboxId),
      });
    } catch (error) {
      this.logger.warn(`transcript unavailable: ${String(error)}`);
      throw new McpToolError('unavailable', 'The conversation could not be read just now.');
    }
    const visible = messages
      .filter((m) => !m.private && m.direction !== 'activity')
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref),
      );
    const page = visible.slice(-input.limit);
    const summary = this.summary(row, loaded.last);
    return {
      data: {
        conversation: summary,
        messages: page.flatMap((message) => {
          const from = senderKind(message);
          if (!from) return [];
          return [
            {
              id: toPublicId('message', authorityMessageUuid(control.connectionId, message.ref)),
              from,
              text: plainText(message.text ?? '', 4000),
              at: message.createdAt.toISOString(),
              ...(message.attachments.length
                ? {
                    attachments: message.attachments.map((a) => ({
                      type: a.fileType,
                      name: a.name ? plainText(a.name, 120) : null,
                    })),
                  }
                : {}),
            },
          ];
        }),
        earlierMessages: Math.max(0, visible.length - page.length),
      },
      count: page.length,
      target: { type: 'conversation', id: summary.conversationId },
    };
  }

  // ── search_knowledge ───────────────────────────────────────────────────────────────

  async searchKnowledge(
    caller: McpCaller,
    input: { query: string; brandId?: string | undefined; limit: number },
  ): Promise<ToolResult> {
    this.scope(caller);
    let only: string | null = null;
    if (input.brandId) {
      try {
        only = fromPublicId('brand', input.brandId);
      } catch {
        throw new McpToolError('not_found', 'No brand with this id is available.');
      }
    }
    const now = this.clock();
    let passages: Awaited<ReturnType<RetrievalService['search']>> = [];
    let brandNames = new Map<string, string>();
    try {
      const result = await this.tx(caller, async (tx) => {
        const brands = (
          await tx.select().from(schema.brands).where(eq(schema.brands.status, 'active'))
        ).filter(
          (brand) =>
            (!only || brand.id === only) &&
            mayRead(caller.principal, { workspaceId: brand.workspaceId, brandId: brand.id }, now),
        );
        const found: typeof passages = [];
        for (const brand of brands.slice(0, 5)) {
          found.push(
            ...(await this.retrieval.search(tx, {
              brandId: brand.id,
              audience: 'staff',
              query: input.query,
              limit: input.limit,
            })),
          );
        }
        return { found, names: new Map(brands.map((b) => [b.id, b.name])), brands };
      });
      passages = result.found;
      brandNames = result.names;
      if (only && result.brands.length === 0) {
        throw new McpToolError('not_found', 'No brand with this id is available.');
      }
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      this.logger.warn(`knowledge search unavailable: ${String(error)}`);
      throw new McpToolError('unavailable', 'The knowledge could not be searched just now.');
    }
    const sources = await this.tx(caller, async (tx) => {
      const ids = [...new Set(passages.map((x) => x.sourceId))];
      if (ids.length === 0) return new Map<string, { brandId: string; visibility: string }>();
      const rows = await tx
        .select({
          id: schema.knowledgeSources.id,
          brandId: schema.knowledgeSources.brandId,
          visibility: schema.knowledgeSources.visibility,
        })
        .from(schema.knowledgeSources)
        .where(inArray(schema.knowledgeSources.id, ids));
      return new Map(rows.map((r) => [r.id, { brandId: r.brandId, visibility: r.visibility }]));
    });
    const results = passages
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
      .map((passage) => {
        const source = sources.get(passage.sourceId);
        return {
          brand: source ? (brandNames.get(source.brandId) ?? null) : null,
          document: passage.title,
          heading: passage.heading,
          url: passage.url,
          audience: source?.visibility === 'public' ? 'public' : 'internal',
          text: plainText(passage.text, 1500),
          documentId: toPublicId('document', passage.documentId),
        };
      });
    return { data: { results }, count: results.length };
  }

  // ── get_customer_memory ────────────────────────────────────────────────────────────

  async customerMemory(
    caller: McpCaller,
    input: { conversationId?: string | undefined; customerId?: string | undefined },
  ): Promise<ToolResult> {
    const scope = this.scope(caller);
    if (!input.conversationId === !input.customerId) {
      throw new McpToolError('invalid', 'Give either a conversation id or a customer id.');
    }
    const now = this.clock();
    const notFound = () => new McpToolError('not_found', 'No customer with this id is available.');
    const result = await this.tx(caller, async (tx) => {
      let subjectId: string | null = null;
      if (input.conversationId) {
        const row = await this.inboxRow(tx, scope, this.conversationRef(input.conversationId));
        if (!row) throw notFound();
        subjectId = row.control.principalId;
        if (!subjectId) return { kind: 'none' as const };
      } else {
        try {
          subjectId = fromPublicId('customer', input.customerId as string);
        } catch {
          throw notFound();
        }
      }
      const [subject] = await tx
        .select({ principal: p, brand: schema.brands })
        .from(p)
        .innerJoin(schema.brands, eq(schema.brands.id, p.brandId))
        .where(eq(p.id, subjectId));
      if (
        !subject ||
        !mayRead(
          caller.principal,
          { workspaceId: subject.brand.workspaceId, brandId: subject.brand.id },
          now,
        )
      ) {
        throw notFound();
      }
      const consents = schema.learningConsents;
      const [consent] = await tx
        .select({ state: consents.state })
        .from(consents)
        .where(and(eq(consents.subjectId, subjectId), eq(consents.scope, 'personal_memory')))
        .orderBy(desc(consents.createdAt), desc(consents.id))
        .limit(1);
      const at = sql`${now.toISOString()}::timestamptz`;
      const r = schema.memoryRecords;
      // The same rules as for the AI's own recall, for the staff purpose: a customer who agreed,
      // current values that allow staff to see them, nothing under review, nothing deleted.
      const records =
        consent?.state === 'granted'
          ? await tx
              .select()
              .from(r)
              .where(
                and(
                  eq(r.subjectId, subjectId),
                  eq(r.brandId, subject.brand.id),
                  eq(r.status, 'active'),
                  eq(r.scope, 'person'),
                  sql`${r.validFrom} <= ${at} and (${r.validUntil} is null or ${r.validUntil} > ${at})`,
                  sql`(${r.expiresAt} is null or ${r.expiresAt} > ${at})`,
                  sql`'staff_context' = any(${r.allowedPurposes}) and 'staff' = any(${r.allowedRoles})`,
                  sql`not exists (
                    select from memory_records pending
                    where pending.subject_id = ${r.subjectId} and pending.key = ${r.key}
                      and pending.status = 'pending')`,
                  sql`not exists (
                    select from deletion_tombstones t
                    where t.subject_id = ${r.subjectId}
                      and ((t.target_type = 'memory_record' and t.target_id = ${r.id})
                        or (t.target_type = 'memory_subject' and ${r.observedAt} <= t.observed_at)))`,
                ),
              )
              .orderBy(asc(r.key))
              .limit(50)
          : [];
      return { kind: 'found' as const, subject, consent: consent?.state ?? 'undecided', records };
    });
    if (result.kind === 'none') {
      return {
        data: {
          customer: null,
          consent: 'undecided',
          memories: [],
          note: 'This conversation has no known customer, so nothing is remembered.',
        },
        count: 0,
      };
    }
    const { subject, consent, records } = result;
    const customerId = toPublicId('customer', subject.principal.id);
    return {
      data: {
        customer: {
          id: customerId,
          name: subject.principal.displayName?.trim() || 'Visitor',
          identity: subject.principal.kind === 'verified' ? 'verified' : 'anonymous',
          brand: subject.brand.name,
        },
        consent,
        memories: records.map((record) => ({
          key: record.key,
          value: plainText(record.payload?.value ?? '', 500),
          kind: record.kind,
          source: record.sourceType,
          confirmed: record.reviewStatus === 'confirmed',
          observedAt: record.observedAt.toISOString(),
        })),
        ...(consent === 'granted'
          ? {}
          : {
              note: 'The customer has not agreed to be remembered, so nothing is shown. What they agreed to or declined is theirs to decide.',
            }),
      },
      count: records.length,
      target: { type: 'customer', id: customerId },
    };
  }

  // ── list_open_handoffs ─────────────────────────────────────────────────────────────

  async openHandoffs(
    caller: McpCaller,
    input: { brandId?: string | undefined; limit: number },
  ): Promise<ToolResult> {
    const scope = this.scope(caller);
    let only: string | null = null;
    if (input.brandId) {
      try {
        only = fromPublicId('brand', input.brandId);
      } catch {
        throw new McpToolError('not_found', 'No brand with this id is available.');
      }
    }
    const waitingSince = sql`coalesce(${c.ownerChangedAt}, ${c.lastCustomerMessageAt}, ${c.createdAt})`;
    const { rows, last, packets } = await this.tx(caller, async (tx) => {
      const rows = await selectRows(tx)
        .where(
          and(
            InboxAccess.condition(scope),
            inArray(c.ownerMode, ['WAITING_HUMAN', 'PAUSED']),
            inArray(c.authorityStatus, ['open', 'pending']),
            only ? eq(c.brandId, only) : undefined,
          ),
        )
        .orderBy(asc(waitingSince))
        .limit(input.limit);
      const ids = rows.map((row) => row.control.id);
      const last = await lastMessages(tx, ids);
      const found = ids.length
        ? await tx
            .select()
            .from(schema.handoffPackets)
            .where(inArray(schema.handoffPackets.conversationId, ids))
            .orderBy(desc(schema.handoffPackets.epoch))
        : [];
      const packets = new Map<string, (typeof found)[number]>();
      for (const packet of found) {
        if (!packets.has(packet.conversationId)) packets.set(packet.conversationId, packet);
      }
      return { rows, last, packets };
    });
    const handoffs = rows.map((row) => {
      const view = toInboxConversation(row, last.get(row.control.id));
      const packet = packets.get(row.control.id)?.packet as
        | { reasonText?: unknown; request?: unknown }
        | undefined;
      return {
        ...this.summary(row, last),
        waitingSince: view.waitingSince,
        reason:
          typeof packet?.reasonText === 'string'
            ? plainText(packet.reasonText, 300)
            : view.ownerMode === 'PAUSED'
              ? 'The AI is paused for this conversation.'
              : 'The conversation is waiting for a person.',
        customerRequest:
          typeof packet?.request === 'string' ? plainText(packet.request, 300) : null,
        customerStatus: customerView(row.control.ownerMode, row.control.authorityStatus).status,
        channel: channelOf(row.channelType),
      };
    });
    return { data: { handoffs }, count: handoffs.length };
  }
}
