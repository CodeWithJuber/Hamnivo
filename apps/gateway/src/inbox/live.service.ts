import { schema, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { PrincipalService } from '../identity/principal.service.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { InboxAccess } from './access.js';
import { type InboxSignal, InboxSignals } from './signals.service.js';

/** Signals are gathered this long before visibility is checked and a batch is sent. */
const BATCH_MS = 250;

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
    const changed = await this.signals.setPresence(
      principal.tenantId,
      found.control.id,
      { staffMemberId: principal.staffMemberId, displayName: await this.nameOf(principal) },
      input.state,
      input.lane ?? null,
    );
    if (changed) await this.signals.changed(principal.tenantId, [found.control.id], 'presence');
    const records = await this.signals.presence(principal.tenantId, found.control.id);
    return { viewers: InboxSignals.view(records, principal.staffMemberId) };
  }

  /** Which of these conversations (UUIDs) the principal may read. */
  private async visible(principal: StaffPrincipal, ids: string[]): Promise<string[]> {
    const scope = this.access.scope(principal);
    if (!scope || ids.length === 0) return [];
    const c = schema.conversationControls;
    const rows = await this.access.tx(principal, (tx) =>
      tx
        .select({ id: c.id })
        .from(c)
        .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
        .leftJoin(
          schema.conversationInboxState,
          eq(schema.conversationInboxState.conversationId, c.id),
        )
        .where(and(inArray(c.id, ids), InboxAccess.condition(scope))),
    );
    return rows.map((r) => r.id);
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
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
      timer = undefined;
      const ids = [...changed];
      const who = [...presence];
      changed.clear();
      presence.clear();
      try {
        const allowed = new Set(await this.visible(principal, [...new Set([...ids, ...who])]));
        const visibleChanges = ids.filter((id) => allowed.has(id));
        if (visibleChanges.length) {
          write('inbox.changed', {
            type: 'inbox.changed',
            conversationIds: visibleChanges.map((id) => toPublicId('conversation', id)),
          });
        }
        for (const id of who.filter((w) => allowed.has(w))) {
          const records = await this.signals.presence(principal.tenantId, id);
          write('presence', {
            type: 'presence',
            conversationId: toPublicId('conversation', id),
            viewers: InboxSignals.view(records, principal.staffMemberId),
          });
        }
      } catch (error) {
        this.logger.warn(`inbox stream flush failed: ${String(error)}`);
      }
    };
    const onSignal = (signal: InboxSignal) => {
      (signal.kind === 'presence' ? presence : changed).add(signal.conversationId);
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
