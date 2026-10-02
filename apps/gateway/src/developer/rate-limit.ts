import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';

const WINDOW_MS = 60_000;

/**
 * Each API key has its own budget of requests per minute (API_KEY_RATE_LIMIT_PER_MINUTE), on top
 * of the per-address limit every request has. It is counted after the key is verified, so made-up
 * keys cannot open new budgets; they stay under the address limit. Like the address limit, it
 * lets requests through while Valkey is unreachable.
 */
@Injectable()
export class ApiKeyRateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async check(keyId: string): Promise<void> {
    const limit = this.config.API_KEY_RATE_LIMIT_PER_MINUTE;
    const now = this.clock().getTime();
    const window = Math.floor(now / WINDOW_MS);
    const bucket = `${this.config.CACHE_KEY_PREFIX}rate:api-key:${keyId}:${window}`;
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
    if (count <= limit) return;
    const resetsAt = new Date((window + 1) * WINDOW_MS);
    throw new AppError('RATE_LIMITED', {
      detail: `This API key may send ${limit} requests a minute. Wait and try again.`,
      retryAfter: Math.max(1, Math.ceil((resetsAt.getTime() - now) / 1000)),
      quota: {
        scope: 'api_key',
        limit: 'requestsPerMinute',
        max: limit,
        used: count,
        resetsAt: resetsAt.toISOString(),
      },
    });
  }
}
