import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import { ReplyLanguage } from './language.js';

export const CacheTier = z
  .enum(['exact_answer', 'nlp', 'embedding', 'retrieval', 'translation'])
  .meta({ id: 'CacheTier' });
export type CacheTier = z.infer<typeof CacheTier>;

export const CacheDataClass = z
  .enum([
    'general',
    'public_knowledge',
    'internal_knowledge',
    'personal',
    'identity',
    'account',
    'memory',
    'live_order',
    'payment',
    'approval',
    'tool_result',
  ])
  .meta({ id: 'CacheDataClass' });

export const CacheTierPolicy = z
  .object({
    enabled: z.boolean(),
    /** How long an entry may be reused. At most 30 days. */
    ttlSeconds: z
      .int()
      .min(60)
      .max(30 * 86_400),
  })
  .meta({ id: 'CacheTierPolicy' });

/** A brand's cache policy (K01, HNV-25-01). */
export const CachePolicy = z
  .object({
    brandId: typeId('brand'),
    version: z.int().nonnegative(),
    tiers: z.record(CacheTier, CacheTierPolicy),
    excludedClasses: z.array(CacheDataClass),
    /** Data that is never cached, whatever the policy says. */
    neverCached: z.array(CacheDataClass),
    updatedAt: Timestamp.nullable(),
    updatedBy: typeId('staff').nullable(),
  })
  .meta({ id: 'CachePolicy' });
export type CachePolicy = z.infer<typeof CachePolicy>;

export const UpdateCachePolicyRequest = z
  .object({
    tiers: z.partialRecord(CacheTier, CacheTierPolicy),
    excludedClasses: z.array(CacheDataClass).max(11).optional(),
  })
  .meta({ id: 'UpdateCachePolicyRequest' });

/** A source a cached answer cites: references and versions, never its text. */
export const CacheSourceRef = z
  .object({
    documentId: typeId('document'),
    sourceId: typeId('source'),
    title: z.string(),
    version: z.int().positive(),
  })
  .meta({ id: 'CacheSourceRef' });

/**
 * What the cache would do for a question from a public visitor (HNV-25-02 to HNV-25-04). The
 * preview shows the stored answer only for an eligible hit, which never holds personal data.
 */
export const CacheInspection = z
  .object({
    tier: CacheTier,
    status: z.enum(['hit', 'miss', 'stale', 'bypass', 'unavailable']),
    /** Why it bypassed or missed, as a code (for example `personal_data`, `tier_disabled`). */
    reason: z.string().nullable(),
    rule: z.string().nullable(),
    fingerprint: z.string().nullable(),
    language: ReplyLanguage,
    knowledge: z.array(z.object({ sourceId: typeId('source'), version: z.int().nonnegative() })),
    expiresAt: Timestamp.nullable(),
    preview: z.string().nullable(),
    sources: z.array(CacheSourceRef),
  })
  .meta({ id: 'CacheInspection' });
export type CacheInspection = z.infer<typeof CacheInspection>;

export const InspectCacheRequest = z
  .object({
    question: z.string().trim().min(1).max(500),
    language: ReplyLanguage.optional(),
  })
  .meta({ id: 'InspectCacheRequest' });

/** An entry as the index knows it: fingerprint, versions and references, never content. */
export const CacheEntry = z
  .object({
    fingerprint: z.string(),
    tier: CacheTier,
    language: z.string().nullable(),
    audience: z.enum(['public', 'staff']),
    model: z.string().nullable(),
    dependencies: z.record(z.string(), z.int()),
    sources: z.array(CacheSourceRef),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    hits: z.int(),
    lastHitAt: Timestamp.nullable(),
    /** A dependency changed since the entry was stored: it will never be read again. */
    stale: z.boolean(),
    invalidatedAt: Timestamp.nullable(),
    invalidationReason: z.string().nullable(),
  })
  .meta({ id: 'CacheEntry' });
export type CacheEntry = z.infer<typeof CacheEntry>;

export const InvalidateCacheRequest = z
  .object({
    /** Only entries that cite this source; otherwise every entry of the brand's tiers. */
    sourceId: typeId('source').optional(),
    tier: CacheTier.optional(),
    reason: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'InvalidateCacheRequest' });

/** What an invalidation did (HNV-25-05): reads stop at once, keys are removed afterwards. */
export const CacheInvalidation = z
  .object({
    invalidated: z.int().nonnegative(),
    removed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    dependencies: z.record(z.string(), z.int()),
  })
  .meta({ id: 'CacheInvalidation' });

/** How many cached answers depend on a source (the invalidation preview). */
export const CacheImpact = z
  .object({
    sourceId: typeId('source'),
    version: z.int().nonnegative(),
    entries: z.int().nonnegative(),
  })
  .meta({ id: 'CacheImpact' });

export const CacheMetricsRow = z
  .object({
    day: z.string(),
    tier: CacheTier,
    language: z.string(),
    hits: z.int(),
    misses: z.int(),
    bypasses: z.int(),
    stores: z.int(),
    stale: z.int(),
    errors: z.int(),
    savedInputTokens: z.int(),
    savedOutputTokens: z.int(),
    savedMs: z.int(),
    lookupMs: z.int(),
  })
  .meta({ id: 'CacheMetricsRow' });

/** Counts per day, tier and language (K10), and the store's health (HNV-25-06). */
export const CacheMetrics = z
  .object({
    brandId: typeId('brand'),
    rows: z.array(CacheMetricsRow),
    health: z.object({
      store: z.enum(['up', 'degraded']),
      /** Failed or timed-out cache operations in this process during the last 15 minutes. */
      recentFailures: z.int().nonnegative(),
    }),
  })
  .meta({ id: 'CacheMetrics' });
export type CacheMetrics = z.infer<typeof CacheMetrics>;
