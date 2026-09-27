import { toPublicId } from '@hamnivo/db';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK, type Clock, REDIS } from '../tokens.js';
import { inboxChannel } from './projection.js';

/** A staff member looking at (or typing in) a conversation. */
export interface PresenceRecord {
  staffMemberId: string;
  displayName: string;
  state: 'viewing' | 'typing';
  lane: 'public' | 'internal' | null;
  /** When this state started (ms). */
  since: number;
  /** Last heartbeat (ms). */
  seenAt: number;
}

export interface InboxSignal {
  /** Conversation UUID. */
  conversationId: string;
  kind: 'change' | 'presence';
}

/** A viewer who has not sent a heartbeat for this long is gone. */
export const PRESENCE_TTL_MS = 30_000;

const channelOf = inboxChannel;
const presenceKey = (tenantId: string, conversationId: string) =>
  `hamnivo:presence:${tenantId}:${conversationId}`;

/**
 * Staff-side live signals (ADR 0004 style): Valkey pub/sub only says "this conversation changed" or
 * "who is here changed"; streams then read the current state. Presence lives in Valkey with a
 * short expiry and is never stored in the database.
 */
@Injectable()
export class InboxSignals implements OnApplicationShutdown {
  private readonly logger = new Logger(InboxSignals.name);
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<(signal: InboxSignal) => void>>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Announces changes after the transaction that made them committed. Never throws. */
  async changed(tenantId: string, conversationIds: string[], kind: InboxSignal['kind'] = 'change') {
    if (conversationIds.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const id of new Set(conversationIds)) {
        pipeline.publish(channelOf(tenantId), JSON.stringify({ c: id, k: kind }));
      }
      await pipeline.exec();
    } catch (error) {
      // Streams also poll, so a lost signal only adds latency.
      this.logger.warn(`inbox signal failed: ${String(error)}`);
    }
  }

  async subscribe(tenantId: string, listener: (signal: InboxSignal) => void): Promise<() => void> {
    const channel = channelOf(tenantId);
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (name: string, message: string) => {
        let parsed: { c?: unknown; k?: unknown };
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        if (typeof parsed.c !== 'string') return;
        const signal: InboxSignal = {
          conversationId: parsed.c,
          kind: parsed.k === 'presence' ? 'presence' : 'change',
        };
        for (const fn of this.listeners.get(name) ?? []) fn(signal);
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

  /** Records what a staff member is doing in a conversation; returns true when it changed. */
  async setPresence(
    tenantId: string,
    conversationId: string,
    staff: { staffMemberId: string; displayName: string },
    state: 'viewing' | 'typing' | 'left',
    lane: 'public' | 'internal' | null,
  ): Promise<boolean> {
    const key = presenceKey(tenantId, conversationId);
    const now = this.clock().getTime();
    const previous = await this.read(key, staff.staffMemberId);
    if (state === 'left') {
      await this.redis.hdel(key, staff.staffMemberId);
      return previous !== null && now - previous.seenAt < PRESENCE_TTL_MS;
    }
    const same =
      previous !== null &&
      previous.state === state &&
      previous.lane === lane &&
      now - previous.seenAt < PRESENCE_TTL_MS;
    const record: PresenceRecord = {
      staffMemberId: staff.staffMemberId,
      displayName: staff.displayName,
      state,
      lane,
      since: same && previous ? previous.since : now,
      seenAt: now,
    };
    await this.redis
      .multi()
      .hset(key, staff.staffMemberId, JSON.stringify(record))
      .pexpire(key, PRESENCE_TTL_MS * 2)
      .exec();
    return !same;
  }

  private async read(key: string, field: string): Promise<PresenceRecord | null> {
    const raw = await this.redis.hget(key, field);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PresenceRecord;
    } catch {
      return null;
    }
  }

  /** Staff currently in a conversation (heartbeat within the last 30 s), oldest first. */
  async presence(tenantId: string, conversationId: string): Promise<PresenceRecord[]> {
    const key = presenceKey(tenantId, conversationId);
    let all: Record<string, string>;
    try {
      all = await this.redis.hgetall(key);
    } catch (error) {
      this.logger.warn(`presence read failed: ${String(error)}`);
      return [];
    }
    const now = this.clock().getTime();
    const live: PresenceRecord[] = [];
    const stale: string[] = [];
    for (const [field, raw] of Object.entries(all)) {
      try {
        const record = JSON.parse(raw) as PresenceRecord;
        if (now - record.seenAt < PRESENCE_TTL_MS) live.push(record);
        else stale.push(field);
      } catch {
        stale.push(field);
      }
    }
    if (stale.length) await this.redis.hdel(key, ...stale).catch(() => undefined);
    return live.sort((a, b) => a.since - b.since);
  }

  /** The contract view of presence, without the caller. */
  static view(records: PresenceRecord[], exceptStaffMemberId: string) {
    return records
      .filter((r) => r.staffMemberId !== exceptStaffMemberId)
      .map((r) => ({
        staffMemberId: toPublicId('staff', r.staffMemberId),
        displayName: r.displayName,
        state: r.state,
        lane: r.lane,
        since: new Date(r.since).toISOString(),
      }));
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }
}
