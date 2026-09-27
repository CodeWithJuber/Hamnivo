import type { EventType } from '@hamnivo/contracts';
import { type Db, newId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';

export type Lane = 'customer' | 'staff' | 'agent_work';

export interface JournalInput {
  lane: Lane;
  type: EventType;
  data: Record<string, unknown>;
  correlationId?: string | null;
  authorityCreatedAt?: Date | null;
  authorityId?: number | null;
}

export interface JournalEntry {
  lane: Lane;
  seq: number;
  event: Record<string, unknown>;
}

export interface JournalPage {
  events: Record<string, unknown>[];
  head: number;
  /** The cursor is older than the retained journal: reload history, then stream again. */
  resyncRequired: boolean;
}

const channelOf = (tenantId: string, conversationId: string) =>
  `hamnivo:journal:${tenantId}:${conversationId}`;

/**
 * Realtime journal (ADR 0004): a short-lived, ordered projection that streams replay by sequence.
 * Each lane has its own gapless sequence, so a customer stream reveals nothing about staff notes.
 * Valkey pub/sub only says "something new"; readers always read from the database by cursor.
 */
@Injectable()
export class JournalService implements OnApplicationShutdown {
  private readonly logger = new Logger(JournalService.name);
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Appends events inside the caller's transaction. The sequences come from the conversation's
   * control row, which this update locks, so appends to one conversation are serialized.
   */
  async append(
    tx: TenantTx,
    tenantId: string,
    conversationId: string,
    inputs: JournalInput[],
  ): Promise<JournalEntry[]> {
    if (inputs.length === 0) return [];
    const count = (lane: Lane) => inputs.filter((i) => i.lane === lane).length;
    const c = schema.conversationControls;
    const now = this.clock();
    const [heads] = await tx
      .update(c)
      .set({
        journalSeq: sql`${c.journalSeq} + ${count('customer')}`,
        staffJournalSeq: sql`${c.staffJournalSeq} + ${count('staff')}`,
        agentJournalSeq: sql`${c.agentJournalSeq} + ${count('agent_work')}`,
        lastActivityAt: now,
      })
      .where(eq(c.id, conversationId))
      .returning({
        customer: c.journalSeq,
        staff: c.staffJournalSeq,
        agent_work: c.agentJournalSeq,
      });
    if (!heads) throw new Error(`No control record for conversation ${conversationId}`);
    const next: Record<Lane, number> = {
      customer: heads.customer - count('customer'),
      staff: heads.staff - count('staff'),
      agent_work: heads.agent_work - count('agent_work'),
    };
    const expiresAt = new Date(now.getTime() + this.config.JOURNAL_RETENTION_DAYS * 86_400_000);
    const entries = inputs.map((input) => {
      next[input.lane] += 1;
      const seq = next[input.lane];
      // A message carries its own position in the lane it is journaled on.
      const message = input.data.message as { sequence?: number | null } | undefined;
      const data = message ? { ...input.data, message: { ...message, sequence: seq } } : input.data;
      const event = {
        schemaVersion: '1.0',
        eventId: toPublicId('event', newId()),
        conversationId: toPublicId('conversation', conversationId),
        sequence: seq,
        occurredAt: now.toISOString(),
        correlationId: input.correlationId ?? null,
        lane: input.lane,
        type: input.type,
        data,
      };
      return { input, entry: { lane: input.lane, seq, event } };
    });
    await tx.insert(schema.conversationJournal).values(
      entries.map(({ input, entry }) => ({
        tenantId,
        conversationId,
        seq: entry.seq,
        lane: entry.lane,
        eventType: input.type,
        event: entry.event,
        authorityCreatedAt: input.authorityCreatedAt ?? null,
        authorityId: input.authorityId ?? null,
        expiresAt,
      })),
    );
    return entries.map(({ entry }) => entry);
  }

  /** True when a message.created for this authority message is already on the lane. */
  async hasMessage(
    tx: TenantTx,
    conversationId: string,
    lane: Lane,
    authorityId: number,
  ): Promise<boolean> {
    const j = schema.conversationJournal;
    const [row] = await tx
      .select({ seq: j.seq })
      .from(j)
      .where(
        and(
          eq(j.conversationId, conversationId),
          eq(j.lane, lane),
          eq(j.authorityId, authorityId),
          eq(j.eventType, 'message.created'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Wakes live streams of the conversation. Call after the transaction has committed. */
  async notify(tenantId: string, conversationId: string, entries: JournalEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.redis.publish(channelOf(tenantId, conversationId), String(entries.length));
    } catch (error) {
      // Streams also poll, so a lost signal only adds latency.
      this.logger.warn(`journal notify failed: ${String(error)}`);
    }
  }

  async read(
    tenantId: string,
    conversationId: string,
    lane: Lane,
    after: number,
    limit = 100,
  ): Promise<JournalPage> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const c = schema.conversationControls;
      const [control] = await tx
        .select({ customer: c.journalSeq, staff: c.staffJournalSeq, agent_work: c.agentJournalSeq })
        .from(c)
        .where(eq(c.id, conversationId));
      const head = control ? control[lane] : 0;
      const j = schema.conversationJournal;
      const rows = await tx
        .select({ seq: j.seq, event: j.event })
        .from(j)
        .where(and(eq(j.conversationId, conversationId), eq(j.lane, lane), gt(j.seq, after)))
        .orderBy(asc(j.seq))
        .limit(limit);
      const first = rows[0];
      const resyncRequired = after < head && (first === undefined || first.seq > after + 1);
      return {
        events: rows.map((r) => r.event as Record<string, unknown>),
        head,
        resyncRequired,
      };
    });
  }

  /**
   * Calls `listener` whenever the conversation's journal advances (any lane). Returns an
   * unsubscribe function. One Valkey subscriber connection serves every stream in this process.
   */
  async subscribe(
    tenantId: string,
    conversationId: string,
    listener: () => void,
  ): Promise<() => void> {
    const channel = channelOf(tenantId, conversationId);
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (name: string) => {
        for (const fn of this.listeners.get(name) ?? []) fn();
      });
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }
}
