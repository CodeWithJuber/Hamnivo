import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../tokens.js';

/**
 * Cache privacy for customer memory (K09). Memory is never put in a shared cache: recall reads the
 * database for every reply. Each customer has a memory version; any per-customer cache must key
 * its entries with it (and live under `namespace()`), so a change or deletion makes them
 * unreachable, and a deletion also removes them outright.
 */
@Injectable()
export class MemoryCache {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private versionKey(tenantId: string, subjectId: string) {
    return `hamnivo:memory:v:${tenantId}:${subjectId}`;
  }

  /** Where per-customer entries built with memory must live. */
  namespace(tenantId: string, subjectId: string): string {
    return `hamnivo:memory:c:${tenantId}:${subjectId}:`;
  }

  async version(tenantId: string, subjectId: string): Promise<number> {
    return Number((await this.redis.get(this.versionKey(tenantId, subjectId))) ?? 0);
  }

  /** Invalidates everything cached with this customer's memory. */
  async bump(tenantId: string, subjectId: string): Promise<number> {
    return this.redis.incr(this.versionKey(tenantId, subjectId));
  }

  /** Removes every entry under the customer's namespace and bumps their version; returns the count. */
  async purge(tenantId: string, subjectId: string): Promise<number> {
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.namespace(tenantId, subjectId)}*`,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length > 0) removed += await this.redis.del(...keys);
    } while (cursor !== '0');
    await this.bump(tenantId, subjectId);
    return removed;
  }
}
