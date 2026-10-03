import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';

const WINDOW_MS = 60_000;
/** Turns a person may try per minute: each one calls the agent's own model and spends its tokens. */
export const PLAYGROUND_TURNS_PER_MINUTE = 15;

/**
 * "Test your AI" spends the workspace's tokens, so each staff member has a budget of turns per
 * minute. Like the other limits it lets turns through while Valkey is unreachable.
 */
@Injectable()
export class PlaygroundLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async check(staffMemberId: string): Promise<void> {
    const now = this.clock().getTime();
    const window = Math.floor(now / WINDOW_MS);
    const bucket = `${this.config.CACHE_KEY_PREFIX}rate:playground:${staffMemberId}:${window}`;
    let count: number;
    try {
      const results = await this.redis
        .multi()
        .incr(bucket)
        .pexpire(bucket, WINDOW_MS + 1000)
        .exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch {
      return;
    }
    if (count <= PLAYGROUND_TURNS_PER_MINUTE) return;
    const resetsAt = (window + 1) * WINDOW_MS;
    throw new AppError('RATE_LIMITED', {
      detail: `You can try ${PLAYGROUND_TURNS_PER_MINUTE} messages a minute. Wait a moment and try again.`,
      retryAfter: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
    });
  }
}
