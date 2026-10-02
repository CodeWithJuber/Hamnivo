import { z } from 'zod';
import {
  CacheEntry,
  CacheImpact,
  CacheInspection,
  CacheInvalidation,
  CacheMetrics,
  CachePolicy,
  CacheTier,
  InspectCacheRequest,
  InvalidateCacheRequest,
  UpdateCachePolicyRequest,
} from './cache.js';
import type { RouteDef } from './routes.js';

const brandParams = z.object({
  brandId: z.string().meta({ description: 'Brand ID (brd_…)' }),
});

/** Answer and NLP caching of a brand: policy, inspection, invalidation and metrics (board 25). */
export const cacheRoutes = {
  getCachePolicy: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/cache/policy',
    operationId: 'getCachePolicy',
    summary: 'Cache tiers, lifetimes and exclusions of a brand (knowledge.read)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Policy', schema: CachePolicy },
  },
  updateCachePolicy: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/cache/policy',
    operationId: 'updateCachePolicy',
    summary: 'Change tiers and exclusions; earlier entries stop being read (knowledge.manage)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    body: UpdateCachePolicyRequest,
    success: { status: 200, description: 'Policy', schema: CachePolicy },
  },
  inspectCache: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/cache/inspect',
    operationId: 'inspectCache',
    summary: 'What the answer cache would do for a public question (knowledge.read)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    body: InspectCacheRequest,
    success: { status: 200, description: 'Inspection', schema: CacheInspection },
  },
  listCacheEntries: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/cache/entries',
    operationId: 'listCacheEntries',
    summary:
      'Cached entries by fingerprint, versions and sources, without content (knowledge.read)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    query: z.object({
      tier: CacheTier.optional(),
      sourceId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    success: {
      status: 200,
      description: 'Entries',
      schema: z.object({ items: z.array(CacheEntry) }),
    },
  },
  getCacheImpact: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/cache/impact',
    operationId: 'getCacheImpact',
    summary: 'How many cached answers a change to a source would invalidate (knowledge.read)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    query: z.object({ sourceId: z.string() }),
    success: { status: 200, description: 'Impact', schema: CacheImpact },
  },
  invalidateCache: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/cache/invalidate',
    operationId: 'invalidateCache',
    summary: 'Stop reusing entries of a source, a tier or the whole brand (knowledge.manage)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    body: InvalidateCacheRequest,
    success: { status: 200, description: 'Invalidated', schema: CacheInvalidation },
  },
  getCacheMetrics: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/cache/metrics',
    operationId: 'getCacheMetrics',
    summary: 'Hits, misses, bypasses and savings per day, tier and language (knowledge.read)',
    tags: ['Cache'],
    auth: 'staff_session',
    params: brandParams,
    query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
    success: { status: 200, description: 'Metrics', schema: CacheMetrics },
  },
} as const satisfies Record<string, RouteDef>;
