import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { ResourceScope, StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { uuidV5 } from '../authority/uuid.js';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { PrincipalService } from '../identity/principal.service.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { InboxAccess, resourceOf } from './access.js';
import type { AlertChat } from './alerts.js';
import { InboxAlertsService } from './alerts.service.js';
import { type InboxSignal, InboxSignals } from './signals.service.js';
import { TypingSignals } from './typing.service.js';

/** Signals are gathered this long before visibility is checked and a batch is sent. */
const BATCH_MS = 250;
/**
 * Alerts look this far back before the previous batch, so a message saved just before the last
 * look is not missed to a difference between the clocks of the servers; a stream sends each alert
 * once, so the overlap never repeats one.
 */
const ALERT_OVERLAP_MS = 5000;

/**
 * Live staff views (H08): presence ("who else is here, who is typing") and a Server-Sent Events
 * stream per tab that says which visible conversations changed. The stream carries signals only;
 * Studio reloads what changed through the REST API, which applies every permission again.
 */
@Injectable()
export class InboxLiveService {
  private readonly logger = new Logger(InboxLiveService.name);
  private readonly names = new Map<string, { name: string; until: number }>();

  constructor(
    private readonly access: InboxAccess,
    private readonly signals: InboxSignals,
    private readonly typing: TypingSignals,
    private readonly alerts: InboxAlertsService,
    private readonly principals: PrincipalService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async nameOf(principal: StaffPrincipal): Promise<string> {
    const key = `${principal.tenantId}:${principal.staffMemberId}`;
    const cached = this.names.get(key);
    const now = this.clock().getTime();
    if (cached && cached.until > now) return cached.name;
    const [row] = await this.access.tx(principal, (tx) =>
      tx
        .select({ name: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, principal.staffMemberId)),
    );
    const name = row?.name ?? 'Staff';
    this.names.set(key, { name, until: now + 5 * 60_000 });
    return name;
  }

  async presence(
    principal: StaffPrincipal,
    publicId: string,
    input: { state: 'viewing' | 'typing' | 'left'; lane?: 'public' | 'internal' | undefined },
  ) {
    const found = await this.access.tx(principal, (tx) =>
      this.access.authorized(tx, principal, publicId, 'conversations.read'),
    );
    const name = await this.nameOf(principal);
    const before = (await this.signals.presence(principal.tenantId, found.control.id)).find(
      (record) => record.staffMemberId === principal.staffMemberId,
    );
    const changed = await this.signals.setPresence(
      principal.tenantId,
      found.control.id,
      { staffMemberId: principal.staffMemberId, displayName: name },
      input.state,
      input.lane ?? null,
    );
    if (changed) await this.signals.changed(principal.tenantId, [found.control.id], 'presence');
    // The customer hears that a person is writing a reply, never that one is writing a note.
    const writingReply = input.state === 'typing' && input.lane === 'public';
    const wasWritingReply = before?.state === 'typing' && before.lane === 'public';
    if (
      (writingReply || wasWritingReply) &&
      this.access.can(principal, 'conversations.reply', found.resource)
    ) {
      await this.typing.publishStaffTyping(principal.tenantId, found.control.id, {
        participantId: toPublicId(
          'participant',
          uuidV5(found.control.id, `typing:${principal.staffMemberId}`),
        ),
        displayName: name,
        typing: writingReply,
      });
    }
    const records = await this.signals.presence(principal.tenantId, found.control.id);
    return { viewers: InboxSignals.view(records, principal.staffMemberId) };
  }

  /** The conversations (UUIDs) among `ids` that the principal may read, as alerts see them. */
  private async visibleChats(
    principal: StaffPrincipal,
    tx: TenantTx,
    ids: string[],
  ): Promise<(AlertChat & { resource: ResourceScope; alertLeads: boolean })[]> {
    const scope = this.access.scope(principal);
    if (!scope || ids.length === 0) return [];
    const c = schema.conversationControls;
    const rows = await tx
      .select({
        id: c.id,
        authorityStatus: c.authorityStatus,
        ownerMode: c.ownerMode,
        ownerStaffId: c.ownerStaffId,
        ownerReason: c.ownerReason,
        ownerChangedAt: c.ownerChangedAt,
        createdAt: c.createdAt,
        customerName: schema.customerPrincipals.displayName,
        brandId: c.brandId,
        inboxId: c.inboxId,
        workspaceId: schema.brands.workspaceId,
        teamId: schema.conversationInboxState.teamId,
        slaBreachedAt: schema.conversationInboxState.slaBreachedAt,
        ownershipEpoch: c.ownershipEpoch,
        teamOffers: sql<boolean>`coalesce(${schema.teams.assignmentMode} = 'offer' and ${schema.teams.status} = 'active', false)`,
        offersEndedAt: schema.conversationInboxState.offersEndedAt,
        offersEndedEpoch: schema.conversationInboxState.offersEndedEpoch,
        offerId: schema.conversationOffers.id,
        offerStaffId: schema.conversationOffers.staffMemberId,
        offeredAt: schema.conversationOffers.offeredAt,
        alertLeads: sql<boolean>`coalesce(${schema.slaPolicies.enabled} and ${schema.slaPolicies.overdueAlertLeads}, false)`,
      })
      .from(c)
      .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
      .leftJoin(
        schema.conversationInboxState,
        eq(schema.conversationInboxState.conversationId, c.id),
      )
      .leftJoin(schema.customerPrincipals, eq(schema.customerPrincipals.id, c.principalId))
      .leftJoin(schema.teams, eq(schema.teams.id, schema.conversationInboxState.teamId))
      .leftJoin(
        schema.slaPolicies,
        and(eq(schema.slaPolicies.brandId, c.brandId), eq(schema.slaPolicies.tenantId, c.tenantId)),
      )
      .leftJoin(
        schema.conversationOffers,
        and(
          eq(schema.conversationOffers.conversationId, c.id),
          eq(schema.conversationOffers.state, 'pending'),
        ),
      )
      .where(and(inArray(c.id, ids), InboxAccess.condition(scope)));
    return rows.map(({ brandId, inboxId, workspaceId, teamId, ...chat }) => ({
      ...chat,
      resource: resourceOf({ brandId, inboxId }, workspaceId, teamId),
    }));
  }

  async stream(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AuthSession,
    initial: StaffPrincipal,
  ): Promise<void> {
    let principal = initial;
    let closed = false;
    const headers: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value as string | number | string[];
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': String(request.id),
    });
    raw.write(`retry: 3000\n: stream open\n\n`);
    const write = (event: string, data: unknown) => {
      if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const changed = new Set<string>();
    const presence = new Set<string>();
    const typed = new Set<string>();
    /** Alerts already sent on this stream, so one never repeats. */
    const alerted = new Map<string, number>();
    const opened = this.clock().getTime();
    /** Alerts cover what happened after this; the first look starts when the stream opened. */
    let since = opened;
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
      timer = undefined;
      const ids = [...changed];
      const who = [...presence];
      const typing = [...typed];
      changed.clear();
      presence.clear();
      typed.clear();
      const lookedAt = this.clock().getTime();
      try {
        const wanted = [...new Set([...ids, ...who, ...typing])];
        const { chats, decision } = await this.access.tx(principal, async (tx) => {
          const chats = await this.visibleChats(principal, tx, wanted);
          const known = new Set(ids);
          // Alerts are for people who can answer the chat, not for everyone who may read it; and
          // for its leads when it goes overdue, if the brand alerts them (ADR 0016).
          const decision = await this.alerts.derive(
            principal,
            tx,
            chats
              .filter((chat) => known.has(chat.id))
              .map(({ alertLeads, ...chat }) => ({
                ...chat,
                canReply: this.access.can(principal, 'conversations.reply', chat.resource),
                leadAlert:
                  alertLeads && this.access.can(principal, 'conversations.assign', chat.resource),
              }))
              .filter((chat) => chat.canReply || chat.leadAlert),
            new Date(since),
            new Set(alerted.keys()),
          );
          return { chats, decision };
        });
        since = lookedAt - ALERT_OVERLAP_MS;
        for (const key of decision.looked) alerted.set(key, lookedAt);
        const allowed = new Set(chats.map((chat) => chat.id));
        const visibleChanges = ids.filter((id) => allowed.has(id));
        if (visibleChanges.length) {
          write('inbox.changed', {
            type: 'inbox.changed',
            conversationIds: visibleChanges.map((id) => toPublicId('conversation', id)),
          });
        }
        for (const alert of decision.alerts) {
          alerted.set(alert.key, lookedAt);
          write('alert', {
            type: 'alert',
            kind: alert.kind,
            conversationId: toPublicId('conversation', alert.conversationId),
            customerName: alert.customerName,
            preview: alert.preview,
            at: alert.at.toISOString(),
          });
        }
        for (const [key, at] of alerted) {
          if (lookedAt - at > 10 * 60_000) alerted.delete(key);
        }
        for (const id of who.filter((w) => allowed.has(w))) {
          const records = await this.signals.presence(principal.tenantId, id);
          write('presence', {
            type: 'presence',
            conversationId: toPublicId('conversation', id),
            viewers: InboxSignals.view(records, principal.staffMemberId),
          });
        }
        for (const id of typing.filter((t) => allowed.has(t))) {
          write('customer_typing', {
            type: 'customer_typing',
            conversationId: toPublicId('conversation', id),
            typing: await this.typing.customerTyping(principal.tenantId, id),
          });
        }
      } catch (error) {
        this.logger.warn(`inbox stream flush failed: ${String(error)}`);
      }
    };
    const onSignal = (signal: InboxSignal) => {
      if (signal.kind === 'read') {
        // Reading is one person's: only their own streams (other tabs) update.
        if (signal.staffMemberId !== principal.staffMemberId) return;
        changed.add(signal.conversationId);
      } else if (signal.kind === 'presence') presence.add(signal.conversationId);
      else if (signal.kind === 'typing') typed.add(signal.conversationId);
      else changed.add(signal.conversationId);
      timer ??= setTimeout(() => void flush(), BATCH_MS);
    };

    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const end = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      unsubscribe();
      raw.end();
    };
    request.raw.on('close', end);
    unsubscribe = await this.signals.subscribe(principal.tenantId, onSignal);
    heartbeat = setInterval(() => {
      void (async () => {
        // Each heartbeat checks the session and the grants again: sign-out, suspension or a
        // revoked role ends the stream.
        const current = await this.principals.session(request).catch(() => null);
        const next =
          current && current.session.id === session.session.id
            ? await this.principals.principal(current, principal.tenantId).catch(() => null)
            : null;
        if (!next || !this.access.scope(next)) {
          write('control', { control: 'auth_expired' });
          end();
          return;
        }
        principal = next;
        write('control', { control: 'heartbeat', at: this.clock().toISOString() });
      })();
    }, this.config.STREAM_HEARTBEAT_SECONDS * 1000);
  }
}
