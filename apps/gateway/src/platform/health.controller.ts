import type { Db } from '@hamnivo/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import { APP_DB, REDIS } from '../tokens.js';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

/** Liveness (process up) and readiness (dependencies reachable) for load balancers. */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks = await Promise.allSettled([
      withTimeout(this.db.execute(sql`select 1`), 2000),
      withTimeout(this.redis.ping(), 2000),
    ]);
    const [database, valkey] = checks.map((c) => (c.status === 'fulfilled' ? 'ok' : 'unavailable'));
    if (database !== 'ok' || valkey !== 'ok') {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        detail: `database: ${database}, valkey: ${valkey}`,
        retryAfter: 5,
      });
    }
    return { status: 'ok', checks: { database, valkey } };
  }
}
