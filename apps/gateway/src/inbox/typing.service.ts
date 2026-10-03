import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../tokens.js';

/** Someone typing in a conversation, as the other side hears of it. */
export interface StaffTyping {
  /** An opaque reference for this person in this conversation (never their staff id). */
  participantId: string;
  displayName: string;
  typing: boolean;
}

/** A customer who has not sent a sign of life for this long has stopped typing. */
export const CUSTOMER_TYPING_TTL_MS = 8_000;

const customerKey = (tenantId: string, conversationId: string) =>
  `hamnivo:typing:customer:${tenantId}:${conversationId}`;
const staffChannel = (tenantId: string, conversationId: string) =>
  `hamnivo:typing:staff:${tenantId}:${conversationId}`;

/**
 * Typing in both directions (transient: nothing is stored in the database or the journal, and
 * nothing is replayed). A customer's typing is a short-lived flag that staff streams read; a staff
 * member's typing in the reply lane is published to the conversation's customer streams only.
 */
@Injectable()
export class TypingSignals implements OnApplicationShutdown {
  private readonly logger = new Logger(TypingSignals.name);
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<(typing: StaffTyping) => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Notes that the customer is typing (or stopped); true when the state changed. */
  async setCustomerTyping(
    tenantId: string,
    conversationId: string,
    typing: boolean,
  ): Promise<boolean> {
    const key = customerKey(tenantId, conversationId);
    if (!typing) return (await this.redis.del(key)) > 0;
    // SET … NX tells a new typing state from a refresh of the one already shown.
    const started = await this.redis.set(key, '1', 'PX', CUSTOMER_TYPING_TTL_MS, 'NX');
    if (started === 'OK') return true;
    await this.redis.pexpire(key, CUSTOMER_TYPING_TTL_MS);
    return false;
  }

  async customerTyping(tenantId: string, conversationId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(customerKey(tenantId, conversationId))) === 1;
    } catch (error) {
      this.logger.warn(`typing read failed: ${String(error)}`);
      return false;
    }
  }

  /** Tells the conversation's customer streams that a staff member is typing a reply (or stopped). */
  async publishStaffTyping(
    tenantId: string,
    conversationId: string,
    typing: StaffTyping,
  ): Promise<void> {
    try {
      await this.redis.publish(staffChannel(tenantId, conversationId), JSON.stringify(typing));
    } catch (error) {
      // Typing is a courtesy; a lost signal changes nothing that matters.
      this.logger.warn(`typing signal failed: ${String(error)}`);
    }
  }

  /** Calls `listener` for each staff typing signal of the conversation; returns an unsubscribe. */
  async onStaffTyping(
    tenantId: string,
    conversationId: string,
    listener: (typing: StaffTyping) => void,
  ): Promise<() => void> {
    const channel = staffChannel(tenantId, conversationId);
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (name: string, message: string) => {
        let parsed: Partial<StaffTyping>;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        if (
          typeof parsed.participantId !== 'string' ||
          typeof parsed.displayName !== 'string' ||
          typeof parsed.typing !== 'boolean'
        ) {
          return;
        }
        const signal = parsed as StaffTyping;
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

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }
}
