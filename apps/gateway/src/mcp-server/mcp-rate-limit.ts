import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';

const WINDOW_MS = 60_000;

/**
 * Each API key has its own budget of tool calls per minute on the MCP server
 * (MCP_RATE_LIMIT_PER_MINUTE), on top of the budget of requests every key has: a tool call can
 * reach into Chatwoot and search the knowledge base, so it costs more than a read of a list. Like
 * the other limits it counts after the key is verified and lets calls through while Valkey is
 * unreachable.
 */
@Injectable()
export class McpRateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async check(keyId: string, calls: number): Promise<void> {
    if (calls <= 0) return;
    const limit = this.config.MCP_RATE_LIMIT_PER_MINUTE;
    const now = this.clock().getTime();
    const window = Math.floor(now / WINDOW_MS);
    const bucket = `${this.config.CACHE_KEY_PREFIX}rate:mcp:${keyId}:${window}`;
    let count: number;
    try {
      const results = await this.redis
        .multi()
        .incrby(bucket, calls)
        .pexpire(bucket, WINDOW_MS + 1000)
        .exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch {
      return;
    }
    if (count <= limit) return;
    const resetsAt = new Date((window + 1) * WINDOW_MS);
    throw new AppError('RATE_LIMITED', {
      detail: `This API key may make ${limit} MCP tool calls a minute. Wait and try again.`,
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
