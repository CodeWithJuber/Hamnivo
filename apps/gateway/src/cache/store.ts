import {
  type CacheFailure,
  type CacheStore,
  createValkeyCacheStore,
  failOpen,
} from '@hamnivo/adapters/cache';
import type { CacheExclusionRule } from '@hamnivo/domain';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/** The cache store every cache tier uses (fail-open Valkey, or a test replacement). */
export const CACHE_STORE = Symbol('CACHE_STORE');
/** Test hook: a store to use instead of Valkey (still wrapped fail-open). */
export const CACHE_STORE_OVERRIDE = Symbol('CACHE_STORE_OVERRIDE');
/** The store for entries private to one customer: keys are used as given (see below). */
export const CACHE_PERSONAL_STORE = Symbol('CACHE_PERSONAL_STORE');
/** Optional port that places a customer's private entries (see {@link PersonalCacheScope}). */
export const PERSONAL_CACHE_SCOPE = Symbol('PERSONAL_CACHE_SCOPE');

/** Where one customer's private entries live, and the version of their personal data. */
export interface CustomerCacheScope {
  /**
   * The customer's own key namespace, such as their memory namespace
   * `hamnivo:memory:c:{tenant}:{subject}:`. Deleting the namespace deletes their cache entries.
   */
  prefix: string;
  /** Changes whenever anything personal changes (for example on every memory change). */
  version: string;
}

/**
 * Per-customer caching (K01 with customer memory). The memory module provides it: the namespace
 * and version of a customer. Without a provider, entries for one customer are never cached.
 */
export interface PersonalCacheScope {
  scope(tenantId: string, subjectId: string): Promise<CustomerCacheScope | null>;
}

/** How long after a failure the cache is skipped, so an outage adds no waiting to every reply. */
const COOL_DOWN_MS = 30_000;
const WINDOW_MS = 15 * 60_000;

/**
 * Cache health (K08, HNV-25-06): failed or timed-out operations in this process. After a failure
 * the cache is skipped for a short time and requests compute fresh, so a Valkey outage costs
 * one deadline, not one per request.
 */
@Injectable()
export class CacheHealth {
  private readonly logger = new Logger('cache');
  private failures: number[] = [];

  record(failure: CacheFailure, now = Date.now()) {
    this.failures.push(now);
    this.failures = this.failures.filter((at) => now - at < WINDOW_MS);
    if (this.failures.length === 1 || this.failures.length % 50 === 0) {
      this.logger.warn(`cache ${failure.operation} ${failure.kind}; serving fresh answers`);
    }
  }

  degraded(now = Date.now()): boolean {
    const last = this.failures.at(-1);
    return last !== undefined && now - last < COOL_DOWN_MS;
  }

  recentFailures(now = Date.now()): number {
    return this.failures.filter((at) => now - at < WINDOW_MS).length;
  }
}

/** A dedicated Valkey connection: short timeouts, no offline queue, never shared with BullMQ. */
@Injectable()
export class CacheConnection implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: config.CACHE_TIMEOUT_MS,
      connectTimeout: 2000,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    this.client.on('error', () => undefined);
    void this.client.connect().catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}

export function cacheStoreFactory(
  config: AppConfig,
  health: CacheHealth,
  connection: CacheConnection,
  override?: CacheStore | null,
): CacheStore {
  const client = connection.client;
  const store =
    override ??
    createValkeyCacheStore({
      prefix: config.CACHE_KEY_PREFIX,
      commands: {
        get: (key) => client.get(key),
        set: async (key, value, ttlMs, onlyIfAbsent) =>
          onlyIfAbsent
            ? (await client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK'
            : (await client.set(key, value, 'PX', ttlMs)) === 'OK',
        del: (keys) => client.del(...keys),
      },
    });
  return failOpen(store, {
    timeoutMs: config.CACHE_TIMEOUT_MS,
    onFailure: (failure) => health.record(failure),
  });
}

/**
 * The store for private entries: the key is the customer's namespace plus the entry, used without
 * the deployment prefix so that deleting the namespace (a memory deletion) removes them too. Only
 * {@link CacheService} writes here, and only under a namespace checked to belong to the customer.
 */
export function personalStoreFactory(
  config: AppConfig,
  health: CacheHealth,
  connection: CacheConnection,
  override?: CacheStore | null,
): CacheStore {
  const client = connection.client;
  const ttl = (ttlMs: number) => Math.max(1, Math.ceil(ttlMs));
  const store: CacheStore = override ?? {
    kind: 'valkey',
    get: (key) => client.get(key),
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', ttl(ttlMs));
    },
    setIfAbsent: async (key, value, ttlMs) =>
      (await client.set(key, value, 'PX', ttl(ttlMs), 'NX')) === 'OK',
    delete: (keys) => (keys.length === 0 ? Promise.resolve(0) : client.del(...keys)),
  };
  return failOpen(store, {
    timeoutMs: config.CACHE_TIMEOUT_MS,
    onFailure: (failure) => health.record(failure),
  });
}

/**
 * Exclusions other modules add to the cache policy (K06): commerce registers rules so live order,
 * payment and approval questions are never served from a cache. Rules run after the built-in
 * ones; any rule that returns a reason makes the request bypass the cache.
 */
@Injectable()
export class CacheExclusions {
  private readonly list: CacheExclusionRule[] = [];

  register(rule: CacheExclusionRule): void {
    if (this.list.some((r) => r.id === rule.id)) {
      throw new Error(`cache exclusion "${rule.id}" is already registered`);
    }
    this.list.push(rule);
  }

  rules(): readonly CacheExclusionRule[] {
    return this.list;
  }
}
