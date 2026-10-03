import type {
  CustomerContext,
  InboxConversation,
  InboxConversationDetail,
  InboxListQuery,
  InboxSearchQuery,
  InboxSearchResult,
} from '@hamnivo/contracts';
import { fromPublicId, InvalidPublicIdError, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { AuthorityRegistry } from '../authority/registry.js';
import { StaffLinksService } from '../authority/staff-links.service.js';
import { authorityMessageUuid } from '../authority/uuid.js';
import { senderOf } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import { AgentsService } from '../runtime/agents.service.js';
import { type ConversationAccess, InboxAccess, resourceOf, type VisibleScope } from './access.js';
import { InboxSignals } from './signals.service.js';
import { TypingSignals } from './typing.service.js';
import { unreadCounts } from './unread.js';
import {
  channelTypes,
  type InboxRow,
  lastMessages,
  selectRows,
  toInboxConversation,
} from './views.js';

const c = schema.conversationControls;
const st = schema.conversationInboxState;
const p = schema.customerPrincipals;

interface Cursor {
  t: string;
  id: string;
}

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.t === 'string' && typeof parsed.id === 'string') return parsed;
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', {
    fields: [{ path: 'cursor', message: 'Unknown cursor' }],
  });
}

/** `mine` needs the caller; `team` needs the caller's teams. */
function queueCondition(
  queue: z.output<typeof InboxListQuery>['queue'],
  staffMemberId: string,
  teamIds: string[],
): SQL | undefined {
  switch (queue) {
    case 'mine':
      return and(eq(c.ownerMode, 'HUMAN_ACTIVE'), eq(c.ownerStaffId, staffMemberId));
    case 'unassigned':
      return inArray(c.ownerMode, ['WAITING_HUMAN', 'PAUSED']);
    case 'ai':
      return eq(c.ownerMode, 'AI_ACTIVE');
    case 'team':
      return teamIds.length ? inArray(st.teamId, teamIds) : sql`false`;
    case 'all':
      return undefined;
  }
}

function statusCondition(status: z.output<typeof InboxListQuery>['status']): SQL | undefined {
  switch (status) {
    case 'active':
      return inArray(c.authorityStatus, ['open', 'pending']);
    case 'snoozed':
      return eq(c.authorityStatus, 'snoozed');
    case 'resolved':
      return eq(c.authorityStatus, 'resolved');
    case 'all':
      return undefined;
  }
}

/** Keeps the start of a message around the first match, for search results. */
function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || flat.length <= 200) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 200)}${start + 200 < flat.length ? '…' : ''}`;
}

/**
 * The shared inbox (H01), a conversation's detail and customer context (H06) and search (H07).
 * Lists come from Hamnivo's own control records, filtered by the caller's grants, so queues span
 * every connected Chatwoot account; transcripts are read from Chatwoot as the staff member.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly access: InboxAccess,
    private readonly registry: AuthorityRegistry,
    private readonly staffLinks: StaffLinksService,
    private readonly signals: InboxSignals,
    private readonly typing: TypingSignals,
    private readonly agents: AgentsService,
  ) {}

  private scopeOrNotFound(principal: StaffPrincipal): VisibleScope {
    const scope = this.access.scope(principal);
    if (!scope) {
      throw new AppError('SCOPE_DENIED', {
        detail: 'Your role does not include reading conversations.',
      });
    }
    return scope;
  }

  private async myTeams(tx: TenantTx, staffMemberId: string): Promise<string[]> {
    const rows = await tx
      .select({ teamId: schema.teamMembers.teamId })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(
        and(eq(schema.teamMembers.staffMemberId, staffMemberId), eq(schema.teams.status, 'active')),
      );
    return rows.map((r) => r.teamId);
  }

  async list(principal: StaffPrincipal, query: z.output<typeof InboxListQuery>) {
    const scope = this.scopeOrNotFound(principal);
    const cursor = decodeCursor(query.cursor);
    return this.access.tx(principal, async (tx) => {
      const teams = await this.myTeams(tx, principal.staffMemberId);
      const filters = and(
        InboxAccess.condition(scope),
        statusCondition(query.status),
        query.brandId ? eq(c.brandId, fromPublicId('brand', query.brandId)) : undefined,
        query.channel
          ? inArray(schema.authorityInboxes.channelType, channelTypes(query.channel))
          : undefined,
        query.language
          ? or(eq(p.locale, query.language), ilike(p.locale, `${query.language}-%`))
          : undefined,
        query.label ? sql`${st.labels} @> array[${query.label.toLowerCase()}]::text[]` : undefined,
        query.teamId ? eq(st.teamId, fromPublicId('team', query.teamId)) : undefined,
      );
      const rows = await selectRows(tx)
        .where(
          and(
            filters,
            queueCondition(query.queue, principal.staffMemberId, teams),
            cursor
              ? or(
                  lt(c.lastActivityAt, sql`${cursor.t}::timestamptz`),
                  and(eq(c.lastActivityAt, sql`${cursor.t}::timestamptz`), lt(c.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(c.lastActivityAt), desc(c.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = await lastMessages(
        tx,
        page.map((r) => r.control.id),
      );
      const unread = await this.unreadFor(tx, principal, page);
      const tail = page.at(-1);
      const [counts] = await tx
        .select({
          mine: sql<number>`count(*) filter (where ${c.ownerMode} = 'HUMAN_ACTIVE' and ${c.ownerStaffId} = ${principal.staffMemberId})`.mapWith(
            Number,
          ),
          unassigned:
            sql<number>`count(*) filter (where ${c.ownerMode} in ('WAITING_HUMAN', 'PAUSED'))`.mapWith(
              Number,
            ),
          ai: sql<number>`count(*) filter (where ${c.ownerMode} = 'AI_ACTIVE')`.mapWith(Number),
          team: (teams.length
            ? sql<number>`count(*) filter (where ${inArray(st.teamId, teams)})`
            : sql<number>`0`
          ).mapWith(Number),
          all: sql<number>`count(*)`.mapWith(Number),
        })
        .from(c)
        .innerJoin(schema.authorityInboxes, eq(schema.authorityInboxes.id, c.inboxId))
        .leftJoin(st, eq(st.conversationId, c.id))
        .leftJoin(p, eq(p.id, c.principalId))
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        // The list shows a chat the owner opened to try the widget (it can be answered), but the
        // counts leave it out.
        .where(
          and(
            filters,
            sql`not exists (select 1 from ${schema.testConversations} tc where tc.tenant_id = ${c.tenantId} and tc.conversation_id = ${c.id})`,
          ),
        );
      return {
        items: page.map((row) =>
          toInboxConversation(row, last.get(row.control.id), unread.get(row.control.id) ?? 0),
        ),
        nextCursor:
          rows.length > query.limit && tail
            ? encodeCursor({ t: tail.activityKey, id: tail.control.id })
            : null,
        counts: counts ?? { mine: 0, unassigned: 0, ai: 0, team: 0, all: 0 },
      };
    });
  }

  /**
   * Customer messages the caller has not read, for the rows that are theirs to answer: a chat that
   * is theirs or waits for a person, in a place where they may reply. Other rows are not unread.
   */
  private unreadFor(
    tx: TenantTx,
    principal: StaffPrincipal,
    rows: Pick<InboxRow, 'control' | 'workspaceId' | 'teamId'>[],
  ): Promise<Map<string, number>> {
    return unreadCounts(
      tx,
      principal.staffMemberId,
      rows
        .filter((row) =>
          this.access.can(
            principal,
            'conversations.reply',
            resourceOf(row.control, row.workspaceId, row.teamId),
          ),
        )
        .map((row) => ({
          id: row.control.id,
          ownerMode: row.control.ownerMode,
          ownerStaffId: row.control.ownerStaffId,
        })),
    );
  }

  /** One row by id, in the caller's transaction (after authorization). */
  async row(
    tx: TenantTx,
    conversationId: string,
    /** Whose unread count to show; without one the count is 0. */
    viewer?: StaffPrincipal,
  ): Promise<InboxConversation> {
    const [row] = await selectRows(tx).where(eq(c.id, conversationId));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    const last = await lastMessages(tx, [conversationId]);
    const unread = viewer ? await this.unreadFor(tx, viewer, [row]) : new Map<string, number>();
    return toInboxConversation(
      row as InboxRow,
      last.get(conversationId),
      unread.get(conversationId),
    );
  }

  async detail(principal: StaffPrincipal, publicId: string): Promise<InboxConversationDetail> {
    const { found, conversation, aiAvailable } = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      const conversation = await this.row(tx, found.control.id, principal);
      const answering = found.control.brandId
        ? await this.agents.answering(tx, found.control.brandId)
        : { answering: false as const };
      return { found, conversation, aiAvailable: answering.answering };
    });
    return this.withPermissions(principal, found, conversation, aiAvailable);
  }

  /** Adds what the caller may do and who else is here. */
  async withPermissions(
    principal: StaffPrincipal,
    found: ConversationAccess,
    conversation: InboxConversation,
    aiAvailable: boolean,
  ): Promise<InboxConversationDetail> {
    const can = (permission: Parameters<InboxAccess['can']>[1]) =>
      this.access.can(principal, permission, found.resource);
    const presence = await this.signals.presence(principal.tenantId, found.control.id);
    const customerTyping = await this.typing.customerTyping(principal.tenantId, found.control.id);
    return {
      ...conversation,
      permissions: {
        reply: can('conversations.reply'),
        note: can('conversations.note'),
        takeover: can('conversations.takeover'),
        assign: can('conversations.assign'),
        status: can('conversations.status'),
        tag: can('conversations.tag'),
        review: can('conversations.review'),
        bulk: can('conversations.bulk'),
      },
      presence: InboxSignals.view(presence, principal.staffMemberId),
      aiAvailable,
      customerTyping,
    };
  }

  /** Who the customer is (H06): Hamnivo's verified identity first, allowed attributes after. */
  async customer(principal: StaffPrincipal, publicId: string): Promise<CustomerContext> {
    const scope = this.scopeOrNotFound(principal);
    const context = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      const control = found.control;
      const [principalRow] = control.principalId
        ? await tx.select().from(p).where(eq(p.id, control.principalId))
        : [];
      const [brand] = control.brandId
        ? await tx
            .select({ id: schema.brands.id, name: schema.brands.name })
            .from(schema.brands)
            .where(eq(schema.brands.id, control.brandId))
        : [];
      const [contact] = control.principalId
        ? await tx
            .select({ externalContactId: schema.authorityContacts.externalContactId })
            .from(schema.authorityContacts)
            .where(
              and(
                eq(schema.authorityContacts.inboxId, control.inboxId),
                eq(schema.authorityContacts.principalId, control.principalId),
              ),
            )
        : [];
      const previous = control.principalId
        ? await selectRows(tx)
            .where(
              and(
                InboxAccess.condition(scope),
                eq(c.principalId, control.principalId),
                ne(c.id, control.id),
              ),
            )
            .orderBy(desc(c.lastActivityAt))
            .limit(10)
        : [];
      const last = await lastMessages(
        tx,
        previous.map((r) => r.control.id),
      );
      return { control, principalRow, brand, contact, previous, last };
    });
    const { control, principalRow, brand, previous, last } = context;

    // Contact attributes come from Chatwoot, read as the staff member; internal keys stay out.
    const attributes: { key: string; value: string }[] = [];
    if (context.contact?.externalContactId) {
      try {
        const runtime = await this.registry.get(principal.tenantId, control.connectionId);
        const userRef = await this.staffLinks.ensure(runtime, principal.staffMemberId);
        const found = await runtime.authority.getContact(
          String(context.contact.externalContactId),
          { kind: 'staff', userRef: String(userRef) },
        );
        for (const [key, value] of Object.entries(found.attributes)) {
          if (key.startsWith('hv_') || value === null || value === undefined) continue;
          const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
          attributes.push({ key: key.slice(0, 100), value: text.slice(0, 200) });
        }
      } catch (error) {
        // The rest of the context is Hamnivo's own; show it even when Chatwoot is slow.
        this.logger.warn(`contact attributes unavailable: ${String(error)}`);
      }
    }
    const verified = principalRow?.kind === 'verified';
    return {
      displayName: principalRow?.displayName?.trim() || 'Visitor',
      identity: principalRow ? (verified ? 'verified' : 'anonymous') : 'unknown',
      externalId: verified ? (principalRow?.externalSubject ?? null) : null,
      // An address the website did not verify is shown as such, never as the customer's.
      email: principalRow?.emailVerifiedAt ? (principalRow.email ?? null) : null,
      unverifiedEmail:
        principalRow && !principalRow.emailVerifiedAt ? (principalRow.email ?? null) : null,
      language: principalRow?.locale ?? null,
      brand: brand ? { id: toPublicId('brand', brand.id), name: brand.name } : null,
      customerSince: principalRow?.createdAt.toISOString() ?? null,
      lastSeenAt: principalRow?.lastSeenAt?.toISOString() ?? null,
      attributes,
      previousConversations: previous.map((row) => ({
        id: toPublicId('conversation', row.control.id),
        status: row.control.authorityStatus,
        lastActivityAt: row.control.lastActivityAt.toISOString(),
        preview: last.get(row.control.id)?.preview ?? null,
      })),
    };
  }

  /**
   * Search (H07): customers by name, email or conversation id in Hamnivo, and message text in
   * Chatwoot as the staff member. Both keep only conversations the caller's grants reach.
   */
  async search(
    principal: StaffPrincipal,
    query: z.output<typeof InboxSearchQuery>,
  ): Promise<z.infer<typeof InboxSearchResult>> {
    const scope = this.scopeOrNotFound(principal);
    const page = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString()) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 50) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'cursor', message: 'Unknown cursor' }],
      });
    }
    const q = query.q;
    let conversationById: string | null = null;
    try {
      conversationById = q.startsWith('conv_') ? fromPublicId('conversation', q) : null;
    } catch (error) {
      if (!(error instanceof InvalidPublicIdError)) throw error;
    }
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const found = await this.access.tx(principal, async (tx) => {
      const rows =
        page === 1
          ? await selectRows(tx)
              .where(
                and(
                  InboxAccess.condition(scope),
                  or(
                    ilike(p.displayName, like),
                    ilike(p.email, like),
                    conversationById ? eq(c.id, conversationById) : undefined,
                  ),
                ),
              )
              .orderBy(desc(c.lastActivityAt))
              .limit(20)
          : [];
      const last = await lastMessages(
        tx,
        rows.map((r) => r.control.id),
      );
      const unread = await this.unreadFor(tx, principal, rows);
      // Only accounts where the caller can see conversations: searching elsewhere would create a
      // Chatwoot user for them in accounts their grants do not reach.
      const connections = await tx
        .selectDistinct({ id: c.connectionId })
        .from(c)
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        .leftJoin(st, eq(st.conversationId, c.id))
        .where(InboxAccess.condition(scope));
      return {
        conversations: rows.map((row) =>
          toInboxConversation(row, last.get(row.control.id), unread.get(row.control.id) ?? 0),
        ),
        connections: connections.map((row) => row.id),
      };
    });

    const hits: { connectionId: string; message: AuthorityMessage }[] = [];
    let more = false;
    for (const connectionId of found.connections.slice(0, 10)) {
      try {
        const runtime = await this.registry.get(principal.tenantId, connectionId);
        const userRef = await this.staffLinks.ensure(runtime, principal.staffMemberId);
        const messages = await runtime.authority.searchMessages(q, page, {
          kind: 'staff',
          userRef: String(userRef),
        });
        if (messages.length >= 15) more = true;
        for (const message of messages) hits.push({ connectionId, message });
      } catch (error) {
        throw authorityUnavailable(error, 'Message search is not available right now.');
      }
    }

    // Keep hits in conversations the caller's grants reach (Chatwoot's inbox rights are wider).
    const visible = await this.access.tx(principal, async (tx) => {
      if (hits.length === 0) return new Map<string, string>();
      const refs = hits.map((h) => ({
        connectionId: h.connectionId,
        external: Number(h.message.conversationRef),
      }));
      const rows = await tx
        .select({
          id: c.id,
          connectionId: c.connectionId,
          external: c.externalConversationId,
        })
        .from(c)
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        .leftJoin(st, eq(st.conversationId, c.id))
        .where(
          and(
            InboxAccess.condition(scope),
            or(
              ...refs.map((r) =>
                and(eq(c.connectionId, r.connectionId), eq(c.externalConversationId, r.external)),
              ),
            ),
          ),
        );
      return new Map(rows.map((r) => [`${r.connectionId}:${r.external}`, r.id]));
    });
    const messages = hits
      .filter((h) => h.message.direction !== 'activity' && h.message.text)
      .flatMap((h) => {
        const conversationId = visible.get(`${h.connectionId}:${h.message.conversationRef}`);
        if (!conversationId) return [];
        return [
          {
            conversationId: toPublicId('conversation', conversationId),
            messageId: toPublicId('message', authorityMessageUuid(h.connectionId, h.message.ref)),
            snippet: snippet(h.message.text ?? '', q).slice(0, 300),
            visibility: h.message.private ? ('internal' as const) : ('public' as const),
            sender: senderOf(h.message),
            createdAt: h.message.createdAt.toISOString(),
          },
        ];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      conversations: found.conversations,
      messages,
      nextCursor: more ? Buffer.from(String(page + 1)).toString('base64url') : null,
    };
  }
}
