import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

export const CACHE_TIER_NAMES = [
  'exact_answer',
  'nlp',
  'embedding',
  'retrieval',
  'translation',
] as const;

/**
 * A brand's cache policy (K01, board 25): which tiers are on, how long entries live and which
 * data classes it excludes on top of the ones that are never cached. Every change raises the
 * version, which is part of every key, so earlier entries stop being read.
 */
export const cachePolicies = pgTable(
  'cache_policies',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    version: integer('version').notNull().default(1),
    /** `{ tier: { enabled, ttlSeconds } }` for every tier. */
    tiers: jsonb('tiers').notNull(),
    excludedClasses: text('excluded_classes').array().notNull().default(sql`'{}'::text[]`),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('cache_policies_tenant_id_id_key').on(t.tenantId, t.id),
    unique('cache_policies_brand_key').on(t.tenantId, t.brandId),
    foreignKey({
      name: 'cache_policies_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'cache_policies_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Version counters for everything cached results depend on (K07): `knowledge:source:<id>`,
 * `agent:<id>`, `brand:<id>`, `cache_policy:<brandId>`. Database triggers raise them when
 * knowledge, agents or brands change, in the same transaction as the change.
 */
export const cacheDependencyVersions = pgTable(
  'cache_dependency_versions',
  {
    id: id(),
    tenantId: tenantId(),
    dependency: text('dependency').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('cache_dependency_versions_tenant_id_id_key').on(t.tenantId, t.id),
    unique('cache_dependency_versions_dependency_key').on(t.tenantId, t.dependency),
    tenantIsolation(),
  ],
);

/**
 * What is in the cache, without its content (board 25 inspector, K07 cleanup): tier, key
 * fingerprint, the dependency versions it was stored under, language, audience, model and the
 * sources it cites (ids and versions), with expiry and hits.
 */
export const cacheEntryIndex = pgTable(
  'cache_entry_index',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    tier: text('tier', { enum: CACHE_TIER_NAMES }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    dependencies: jsonb('dependencies').notNull().default({}),
    language: text('language'),
    audience: text('audience', { enum: ['public', 'staff'] }).notNull(),
    model: text('model'),
    sourceRefs: jsonb('source_refs').notNull().default([]),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    hits: integer('hits').notNull().default(0),
    lastHitAt: tstz('last_hit_at'),
    invalidatedAt: tstz('invalidated_at'),
    invalidationReason: text('invalidation_reason'),
  },
  (t) => [
    unique('cache_entry_index_tenant_id_id_key').on(t.tenantId, t.id),
    unique('cache_entry_index_fingerprint_key').on(t.tenantId, t.tier, t.fingerprint),
    index('cache_entry_index_brand_idx').on(t.tenantId, t.brandId, t.createdAt),
    index('cache_entry_index_dependencies_idx').using('gin', t.dependencies),
    foreignKey({
      name: 'cache_entry_index_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Daily counts per brand, tier and language (K10): hits, misses, bypasses, stores, stale reads and
 * errors, with tokens and time saved. Counts only; no questions, answers or keys.
 */
export const cacheMetricsDaily = pgTable(
  'cache_metrics_daily',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    tier: text('tier', { enum: CACHE_TIER_NAMES }).notNull(),
    /** Language of the requests, or '' when none applies. */
    language: text('language').notNull().default(''),
    hits: integer('hits').notNull().default(0),
    misses: integer('misses').notNull().default(0),
    bypasses: integer('bypasses').notNull().default(0),
    stores: integer('stores').notNull().default(0),
    stale: integer('stale').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    savedInputTokens: bigint('saved_input_tokens', { mode: 'number' }).notNull().default(0),
    savedOutputTokens: bigint('saved_output_tokens', { mode: 'number' }).notNull().default(0),
    savedMs: bigint('saved_ms', { mode: 'number' }).notNull().default(0),
    lookupMs: bigint('lookup_ms', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('cache_metrics_daily_tenant_id_id_key').on(t.tenantId, t.id),
    unique('cache_metrics_daily_key').on(t.tenantId, t.brandId, t.day, t.tier, t.language),
    foreignKey({
      name: 'cache_metrics_daily_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);
