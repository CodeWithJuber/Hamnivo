import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { type CacheStore, createSingleflight } from '@hamnivo/adapters/cache';
import { type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import {
  type CacheKey,
  type CachePolicy,
  type CacheRequest,
  type CacheTier,
  cacheEligibility,
  cacheKey,
  cacheKeyMaterial,
  DEFAULT_CACHE_POLICY,
  NEVER_CACHED,
} from '@hamnivo/domain';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, type Column, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import {
  CACHE_PERSONAL_STORE,
  CACHE_STORE,
  CacheExclusions,
  CacheHealth,
  type CustomerCacheScope,
  PERSONAL_CACHE_SCOPE,
  type PersonalCacheScope,
} from './store.js';

export type PolicyRow = typeof schema.cachePolicies.$inferSelect;
export type EntryRow = typeof schema.cacheEntryIndex.$inferSelect;

/** Everything a cached computation depends on; the key is built from it. */
export interface CacheSpec {
  tier: CacheTier;
  tenantId: string;
  brandId: string;
  /** `customer`: private to {@link subjectId}, under their own namespace and personal version. */
  audience: 'public' | 'staff' | 'customer';
  /** The customer principal a `customer` entry belongs to. */
  subjectId?: string;
  language: string | null;
  model: string | null;
  promptVersion: string;
  /** Dependency names; their current versions are read at lookup and become part of the key. */
  dependencies: readonly string[];
  /** The exact input, digested with the tenant's key; never stored or logged. */
  input: string;
  request: CacheRequest;
}

export interface SourceRefRow {
  documentId: string;
  sourceId: string;
  title: string;
  version: number;
}

export type Lookup<T> =
  | {
      status: 'hit';
      value: T;
      key: CacheKey;
      entry: EntryRow | null;
      versions: Record<string, number>;
      ms: number;
    }
  | {
      status: 'miss' | 'stale';
      key: CacheKey;
      lookup: string;
      versions: Record<string, number>;
      ttlSeconds: number;
      /** The older entry for the same question (stale only). */
      previous: EntryRow | null;
      /** Where a private entry goes; null for shared entries. */
      customer: CustomerCacheScope | null;
      ms: number;
    }
  | { status: 'bypass'; reason: string; rule: string; detail: string | null; ms: number }
  | { status: 'unavailable'; ms: number };

interface Stored<T> {
  v: 1;
  complete: true;
  value: T;
}

export interface MetricsDelta {
  hits?: number;
  misses?: number;
  bypasses?: number;
  stores?: number;
  stale?: number;
  errors?: number;
  savedInputTokens?: number;
  savedOutputTokens?: number;
  savedMs?: number;
  lookupMs?: number;
}

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The policy as the domain applies it; a brand without one gets the defaults. */
export function policyOf(row: PolicyRow | undefined): CachePolicy {
  if (!row) return DEFAULT_CACHE_POLICY;
  const tiers = { ...DEFAULT_CACHE_POLICY.tiers, ...(row.tiers as Partial<CachePolicy['tiers']>) };
  return {
    version: row.version,
    tiers,
    excludedClasses: row.excludedClasses as CachePolicy['excludedClasses'],
  };
}

/**
 * The tenant-safe cache (K01, K07, K08, K10). Keys are built by the domain from the tenant,
 * brand, audience, language, model, prompt version, every dependency's current version and a
 * digest of the input keyed per tenant (HKDF from the key-encryption key). Values are stored
 * only when eligible and complete; the index keeps fingerprints and references, never content.
 * Store trouble never fails a request: it reads as a miss and the work is done fresh.
 */
@Injectable()
export class CacheService {
  private readonly flight = createSingleflight();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CACHE_STORE) private readonly store: CacheStore,
    private readonly health: CacheHealth,
    private readonly exclusions: CacheExclusions,
    @Inject(CACHE_PERSONAL_STORE) private readonly personalStore: CacheStore,
    @Optional()
    @Inject(PERSONAL_CACHE_SCOPE)
    private readonly personal: PersonalCacheScope | null = null,
  ) {}

  /** The request as eligibility sees it: private entries may hold personalized results. */
  private requestOf(spec: CacheSpec): CacheRequest {
    return { ...spec.request, scope: spec.audience === 'customer' ? 'customer' : 'shared' };
  }

  /**
   * The customer's namespace and version, checked to be theirs: the namespace must name this
   * tenant and this customer, so an entry can never land in (or be read from) another's.
   */
  private async customerScope(spec: CacheSpec): Promise<CustomerCacheScope | null> {
    if (!this.personal || !spec.subjectId) return null;
    try {
      const scope = await this.personal.scope(spec.tenantId, spec.subjectId);
      if (!scope?.version || !scope.prefix.endsWith(':')) return null;
      const parts = scope.prefix.split(':');
      if (!parts.includes(spec.tenantId) || !parts.includes(spec.subjectId)) return null;
      return scope;
    } catch {
      return null;
    }
  }

  /** Where an entry lives: the shared namespace, or the customer's own. */
  private place(spec: CacheSpec, key: CacheKey, customer: CustomerCacheScope | null) {
    return customer
      ? {
          store: this.personalStore,
          key: `${customer.prefix}cache:${spec.tier}:${key.fingerprint}`,
        }
      : { store: this.store, key: key.key };
  }

  /** HMAC of an input with a per-tenant key, so equal questions of two tenants never share a digest. */
  digest(tenantId: string, input: string): string {
    const key = Buffer.from(
      hkdfSync('sha256', this.config.kek.key, Buffer.from(tenantId), 'hamnivo cache digest v1', 32),
    );
    return createHmac('sha256', key).update(input).digest('hex');
  }

  async policy(
    tx: TenantTx,
    brandId: string,
  ): Promise<{ row: PolicyRow | undefined; policy: CachePolicy }> {
    const [row] = await tx
      .select()
      .from(schema.cachePolicies)
      .where(eq(schema.cachePolicies.brandId, brandId));
    return { row, policy: policyOf(row) };
  }

  async versions(tx: TenantTx, names: readonly string[]): Promise<Record<string, number>> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return {};
    const rows = await tx
      .select({
        dependency: schema.cacheDependencyVersions.dependency,
        version: schema.cacheDependencyVersions.version,
      })
      .from(schema.cacheDependencyVersions)
      .where(inArray(schema.cacheDependencyVersions.dependency, unique));
    const found = new Map(rows.map((r) => [r.dependency, Number(r.version)]));
    return Object.fromEntries(unique.map((name) => [name, found.get(name) ?? 0]));
  }

  private keys(
    spec: CacheSpec,
    versions: Record<string, number>,
    customer: CustomerCacheScope | null = null,
  ) {
    const envelope = {
      tier: spec.tier,
      tenantId: spec.tenantId,
      brandId: spec.brandId,
      audience: spec.audience,
      language: spec.language,
      model: spec.model,
      promptVersion: spec.promptVersion,
      dependencies: versions,
      inputDigest: this.digest(spec.tenantId, spec.input),
      subject:
        customer && spec.subjectId ? { id: spec.subjectId, version: customer.version } : undefined,
    };
    const key = cacheKey(envelope, sha256hex);
    // The same key with every version at 0: shared by entries for the same question over time.
    const lookup = sha256hex(
      cacheKeyMaterial({
        ...envelope,
        dependencies: Object.fromEntries(Object.keys(versions).map((name) => [name, 0])),
      }),
    );
    return { key, lookup };
  }

  /**
   * Looks a computation up. Checks eligibility first (a bypass never touches the store), then
   * reads under the current dependency versions. A miss that finds an entry for the same question
   * under older versions is reported as stale, and that entry is removed. `inspect` looks without
   * counting, touching hit counters or removing anything (Studio's inspector).
   */
  async lookup<T>(spec: CacheSpec, options: { inspect?: boolean } = {}): Promise<Lookup<T>> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const count = (delta: MetricsDelta) =>
      options.inspect ? Promise.resolve() : this.count(spec, delta);
    const prepared = await withTenant(
      this.db,
      { tenantId: spec.tenantId, actorId: 'cache' },
      async (tx) => {
        const { policy } = await this.policy(tx, spec.brandId);
        const eligibility = cacheEligibility(this.requestOf(spec), policy, {
          rules: this.exclusions.rules(),
        });
        if (!eligibility.eligible) return { eligibility, policy, versions: {} };
        return { eligibility, policy, versions: await this.versions(tx, spec.dependencies) };
      },
    );
    const { eligibility, policy, versions } = prepared;
    if (!eligibility.eligible) {
      await count({ bypasses: 1 });
      return {
        status: 'bypass',
        reason: eligibility.reason,
        rule: eligibility.rule,
        detail: eligibility.detail ?? null,
        ms: elapsed(),
      };
    }
    if (this.health.degraded()) {
      await count({ errors: 1 });
      return { status: 'unavailable', ms: elapsed() };
    }
    let customer: CustomerCacheScope | null = null;
    if (spec.audience === 'customer') {
      customer = await this.customerScope(spec);
      if (!customer) {
        await count({ bypasses: 1 });
        return {
          status: 'bypass',
          reason: 'no_customer_scope',
          rule: 'core.customer_scope',
          detail: null,
          ms: elapsed(),
        };
      }
    }
    const { key, lookup } = this.keys(spec, versions, customer);
    const place = this.place(spec, key, customer);
    const failuresBefore = this.health.recentFailures();
    const raw = await place.store.get(place.key);
    if (raw === null && this.health.recentFailures() > failuresBefore) {
      // The read failed or timed out: answer fresh and do not try to store (K08).
      await count({ errors: 1 });
      return { status: 'unavailable', ms: elapsed() };
    }
    const ttlSeconds = policy.tiers[spec.tier].ttlSeconds;
    const parsed = raw === null ? null : this.parse<T>(raw);
    const e = schema.cacheEntryIndex;
    if (parsed !== null && customer) {
      // Private entries are not indexed: they live and go with the customer's namespace.
      await count({ hits: 1, lookupMs: elapsed() });
      return { status: 'hit', value: parsed, key, entry: null, versions, ms: elapsed() };
    }
    if (customer) {
      await count({ misses: 1 });
      return {
        status: 'miss',
        key,
        lookup,
        versions,
        ttlSeconds,
        previous: null,
        customer,
        ms: elapsed(),
      };
    }
    if (parsed !== null) {
      const entry = await withTenant(
        this.db,
        { tenantId: spec.tenantId, actorId: 'cache' },
        async (tx) => {
          const match = and(eq(e.tier, spec.tier), eq(e.fingerprint, key.fingerprint));
          const [row] = options.inspect
            ? await tx.select().from(e).where(match)
            : await tx
                .update(e)
                .set({ hits: sql`${e.hits} + 1`, lastHitAt: this.clock() })
                .where(match)
                .returning();
          return row ?? null;
        },
      );
      await count({ hits: 1, lookupMs: elapsed() });
      return { status: 'hit', value: parsed, key, entry, versions, ms: elapsed() };
    }
    const earlier = await withTenant(this.db, { tenantId: spec.tenantId, actorId: 'cache' }, (tx) =>
      tx
        .select()
        .from(e)
        .where(and(eq(e.brandId, spec.brandId), eq(e.tier, spec.tier), eq(e.lookup, lookup)))
        .orderBy(desc(e.createdAt))
        .limit(5),
    );
    // An entry under the current versions that is gone expired; one under older versions is stale.
    const previous = earlier.some((row) => row.fingerprint === key.fingerprint)
      ? null
      : (earlier[0] ?? null);
    if (previous) {
      if (previous.invalidatedAt === null && !options.inspect) {
        await this.retire([previous], 'dependency_changed');
        await count({ stale: 1, misses: 1 });
      } else {
        await count({ misses: 1 });
      }
      return {
        status: 'stale',
        key,
        lookup,
        versions,
        ttlSeconds,
        previous,
        customer: null,
        ms: elapsed(),
      };
    }
    await count({ misses: 1 });
    return {
      status: 'miss',
      key,
      lookup,
      versions,
      ttlSeconds,
      previous: null,
      customer: null,
      ms: elapsed(),
    };
  }

  private parse<T>(raw: string): T | null {
    try {
      const stored = JSON.parse(raw) as Stored<T>;
      // Only complete, versioned entries are ever read back.
      return stored?.v === 1 && stored.complete === true ? stored.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Stores a value found missing by `lookup`, when the output is complete and still eligible,
   * and indexes it by fingerprint with its dependency versions and sources.
   */
  async put<T>(
    spec: CacheSpec,
    miss: Extract<Lookup<T>, { status: 'miss' | 'stale' }>,
    value: T,
    meta: { sources?: SourceRefRow[] } = {},
  ): Promise<boolean> {
    const stored = await withTenant(
      this.db,
      { tenantId: spec.tenantId, actorId: 'cache' },
      async (tx) => {
        const { policy } = await this.policy(tx, spec.brandId);
        const eligibility = cacheEligibility(this.requestOf(spec), policy, {
          rules: this.exclusions.rules(),
          forStore: true,
        });
        return eligibility.eligible ? policy : null;
      },
    );
    if (!stored || this.health.degraded()) return false;
    const payload: Stored<T> = { v: 1, complete: true, value };
    const ttlMs = miss.ttlSeconds * 1000;
    const place = this.place(spec, miss.key, miss.customer);
    await place.store.set(place.key, JSON.stringify(payload), ttlMs);
    if (this.health.degraded()) return false;
    if (miss.customer) {
      await this.count(spec, { stores: 1 });
      return true;
    }
    // A private entry never enters the shared index (nor, above, the shared namespace).
    const audience = spec.audience;
    if (audience === 'customer') return false;
    await withTenant(this.db, { tenantId: spec.tenantId, actorId: 'cache' }, (tx) =>
      tx
        .insert(schema.cacheEntryIndex)
        .values({
          tenantId: spec.tenantId,
          brandId: spec.brandId,
          tier: spec.tier,
          fingerprint: miss.key.fingerprint,
          lookup: miss.lookup,
          dependencies: miss.versions,
          language: spec.language,
          audience,
          model: spec.model,
          sourceRefs: meta.sources ?? [],
          expiresAt: new Date(this.clock().getTime() + ttlMs),
        })
        .onConflictDoUpdate({
          target: [
            schema.cacheEntryIndex.tenantId,
            schema.cacheEntryIndex.tier,
            schema.cacheEntryIndex.fingerprint,
          ],
          set: {
            expiresAt: new Date(this.clock().getTime() + ttlMs),
            invalidatedAt: null,
            invalidationReason: null,
          },
        }),
    );
    await this.count(spec, { stores: 1 });
    return true;
  }

  /**
   * Checks the store is answering, for the health shown in Studio. Health is kept per process, so
   * the process serving Studio probes on request instead of relying on the traffic it happens to
   * see. Reads a key no entry can have; a failure or timeout is recorded by the fail-open store.
   */
  async probe(): Promise<void> {
    if (!this.health.degraded()) await this.store.get('health:probe');
  }

  /** Runs `compute` once per key in this process while a miss is being filled (K08). */
  coalesce<T>(key: string, compute: () => Promise<T>): Promise<T> {
    return this.flight.run(key, compute);
  }

  /** Removes entries from the store and marks them invalidated in the index. */
  async retire(entries: EntryRow[], reason: string): Promise<{ removed: number; failed: number }> {
    if (entries.length === 0) return { removed: 0, failed: 0 };
    const keys = entries.map((e) => `t:${e.tenantId}:b:${e.brandId}:${e.tier}:${e.fingerprint}`);
    const failuresBefore = this.health.recentFailures();
    const removed = await this.store.delete(keys);
    const failed = this.health.recentFailures() > failuresBefore ? entries.length : 0;
    const byTenant = new Map<string, string[]>();
    for (const entry of entries) {
      byTenant.set(entry.tenantId, [...(byTenant.get(entry.tenantId) ?? []), entry.id]);
    }
    for (const [tenantId, ids] of byTenant) {
      await withTenant(this.db, { tenantId, actorId: 'cache' }, (tx) =>
        tx
          .update(schema.cacheEntryIndex)
          .set({ invalidatedAt: this.clock(), invalidationReason: reason })
          .where(
            and(
              inArray(schema.cacheEntryIndex.id, ids),
              sql`${schema.cacheEntryIndex.invalidatedAt} is null`,
            ),
          ),
      );
    }
    return { removed, failed };
  }

  /** Entries stored under an older version of `dependency` than the current one. */
  async outdated(
    tx: TenantTx,
    brandId: string,
    dependency: string,
    current: number,
  ): Promise<EntryRow[]> {
    return tx
      .select()
      .from(schema.cacheEntryIndex)
      .where(
        and(
          eq(schema.cacheEntryIndex.brandId, brandId),
          sql`${schema.cacheEntryIndex.invalidatedAt} is null`,
          sql`(${schema.cacheEntryIndex.dependencies} ->> ${dependency})::bigint < ${current}`,
        ),
      );
  }

  /** Adds to today's counters for the brand, tier and language (K10). Counts only. */
  async count(
    spec: Pick<CacheSpec, 'tenantId' | 'brandId' | 'tier' | 'language'>,
    delta: MetricsDelta,
  ) {
    const day = this.clock().toISOString().slice(0, 10);
    const m = schema.cacheMetricsDaily;
    const add = (column: Column, value: number | undefined) => sql`${column} + ${value ?? 0}`;
    await withTenant(this.db, { tenantId: spec.tenantId, actorId: 'cache' }, (tx) =>
      tx
        .insert(m)
        .values({
          tenantId: spec.tenantId,
          brandId: spec.brandId,
          day,
          tier: spec.tier,
          language: spec.language ?? '',
          hits: delta.hits ?? 0,
          misses: delta.misses ?? 0,
          bypasses: delta.bypasses ?? 0,
          stores: delta.stores ?? 0,
          stale: delta.stale ?? 0,
          errors: delta.errors ?? 0,
          savedInputTokens: delta.savedInputTokens ?? 0,
          savedOutputTokens: delta.savedOutputTokens ?? 0,
          savedMs: delta.savedMs ?? 0,
          lookupMs: delta.lookupMs ?? 0,
        })
        .onConflictDoUpdate({
          target: [m.tenantId, m.brandId, m.day, m.tier, m.language],
          set: {
            hits: add(m.hits, delta.hits),
            misses: add(m.misses, delta.misses),
            bypasses: add(m.bypasses, delta.bypasses),
            stores: add(m.stores, delta.stores),
            stale: add(m.stale, delta.stale),
            errors: add(m.errors, delta.errors),
            savedInputTokens: add(m.savedInputTokens, delta.savedInputTokens),
            savedOutputTokens: add(m.savedOutputTokens, delta.savedOutputTokens),
            savedMs: add(m.savedMs, delta.savedMs),
            lookupMs: add(m.lookupMs, delta.lookupMs),
            updatedAt: this.clock(),
          },
        }),
    );
  }

  /** Classes a brand can never cache, whatever its policy (shown in Studio). */
  static get neverCached() {
    return NEVER_CACHED;
  }

  /** A hit whose sources no longer qualify: removed, counted as stale, and treated as a miss. */
  async reject<T>(spec: CacheSpec, hit: Extract<Lookup<T>, { status: 'hit' }>, reason: string) {
    if (hit.entry) await this.retire([hit.entry], reason);
    else await this.store.delete([hit.key.key]);
    await this.count(spec, { stale: 1, hits: -1, misses: 1 });
  }
}
