import { randomBytes } from 'node:crypto';
import type { VisitorInvite } from '@hamnivo/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK, type Clock, REDIS } from '../tokens.js';

/** An invitation waits this long for the visitor's next sign of life, then it is gone. */
export const INVITE_TTL_MS = 3 * 60_000;

const keyOf = (tenantId: string, visitorId: string) =>
  `hamnivo:visitor-invite:${tenantId}:${visitorId}`;

/**
 * A message staff typed for a visitor. It waits in Valkey (a few minutes, nothing in the database).
 * The loader is told of it with each report and shows it once next to the chat button, the way it
 * shows a proactive prompt; the chat takes it when the visitor opens the chat, and it is gone.
 */
@Injectable()
export class VisitorInvites {
  private readonly logger = new Logger(VisitorInvites.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Leaves an invitation for the visitor, replacing one that has not been picked up. */
  async offer(
    tenantId: string,
    visitorId: string,
    message: string,
  ): Promise<{ invite: VisitorInvite; expiresAt: Date }> {
    const invite: VisitorInvite = { id: randomBytes(8).toString('hex'), message };
    await this.redis.set(keyOf(tenantId, visitorId), JSON.stringify(invite), 'PX', INVITE_TTL_MS);
    return { invite, expiresAt: new Date(this.clock().getTime() + INVITE_TTL_MS) };
  }

  /** The waiting invitation, left where it is (the loader shows it as often as it is reported). */
  async peek(tenantId: string, visitorId: string): Promise<VisitorInvite | null> {
    return this.read(() => this.redis.get(keyOf(tenantId, visitorId)));
  }

  /** Takes the waiting invitation, if any: once the chat shows it, it is gone. */
  async take(tenantId: string, visitorId: string): Promise<VisitorInvite | null> {
    return this.read(() => this.redis.getdel(keyOf(tenantId, visitorId)));
  }

  private async read(get: () => Promise<string | null>): Promise<VisitorInvite | null> {
    try {
      const raw = await get();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<VisitorInvite>;
      return typeof parsed.id === 'string' && typeof parsed.message === 'string'
        ? { id: parsed.id, message: parsed.message }
        : null;
    } catch (error) {
      // An invitation is a courtesy; a lost one changes nothing that matters.
      this.logger.warn(`invite read failed: ${String(error)}`);
      return null;
    }
  }
}
