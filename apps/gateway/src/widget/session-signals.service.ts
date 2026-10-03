import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../tokens.js';

const channelOf = (tenantId: string, sessionId: string) =>
  `hamnivo:widget-session:${tenantId}:${sessionId}`;

/**
 * Tells open customer streams at once that their session ended (W18): a sign-in as someone else,
 * a sign-out, a revoked key. Streams also re-check their session at every heartbeat, so a lost
 * signal only delays the end until then; it never keeps a stream of the previous person open.
 */
@Injectable()
export class SessionSignals implements OnApplicationShutdown {
  private readonly logger = new Logger(SessionSignals.name);
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Announces that these sessions ended. Call after the change has committed. */
  async ended(tenantId: string, sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const id of sessionIds) pipeline.publish(channelOf(tenantId, id), 'ended');
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(`session signal failed: ${String(error)}`);
    }
  }

  /** Calls `listener` when the session ends; returns an unsubscribe function. */
  async onEnded(tenantId: string, sessionId: string, listener: () => void): Promise<() => void> {
    const channel = channelOf(tenantId, sessionId);
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
