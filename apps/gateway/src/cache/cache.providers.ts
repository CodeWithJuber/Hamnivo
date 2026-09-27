import type { Provider } from '@nestjs/common';
import { QUERY_VECTOR_CACHE } from '../knowledge/retrieval.service.js';
import { MemoryCache } from '../memory/cache.js';
import type { PlatformOverrides } from '../platform/platform.module.js';
import { CONFIG } from '../tokens.js';
import { CacheAdminService } from './admin.service.js';
import { AnswerCache } from './answers.js';
import { CacheService } from './cache.service.js';
import {
  CACHE_PERSONAL_STORE,
  CACHE_STORE,
  CACHE_STORE_OVERRIDE,
  CacheConnection,
  CacheExclusions,
  CacheHealth,
  cacheStoreFactory,
  PERSONAL_CACHE_SCOPE,
  type PersonalCacheScope,
  personalStoreFactory,
} from './store.js';
import { QueryVectors } from './vectors.js';

/** Cache services for both processes: store, policy, answers and query vectors. */
export function cacheProviders(overrides: PlatformOverrides): Provider[] {
  return [
    { provide: CACHE_STORE_OVERRIDE, useValue: overrides.cacheStore ?? null },
    CacheHealth,
    CacheConnection,
    {
      provide: CACHE_STORE,
      inject: [CONFIG, CacheHealth, CacheConnection, CACHE_STORE_OVERRIDE],
      useFactory: cacheStoreFactory,
    },
    {
      provide: CACHE_PERSONAL_STORE,
      inject: [CONFIG, CacheHealth, CacheConnection, CACHE_STORE_OVERRIDE],
      useFactory: personalStoreFactory,
    },
    // A customer's private entries live in their memory namespace, keyed by their memory
    // version (K09): a memory change makes them unreachable and a deletion removes them.
    {
      provide: PERSONAL_CACHE_SCOPE,
      inject: [MemoryCache],
      useFactory: (memory: MemoryCache): PersonalCacheScope | null =>
        overrides.personalCacheScope !== undefined
          ? overrides.personalCacheScope
          : {
              async scope(tenantId, subjectId) {
                return {
                  prefix: memory.namespace(tenantId, subjectId),
                  version: String(await memory.version(tenantId, subjectId)),
                };
              },
            },
    },
    CacheExclusions,
    CacheService,
    AnswerCache,
    QueryVectors,
    { provide: QUERY_VECTOR_CACHE, useExisting: QueryVectors },
  ];
}

/** Studio's cache administration (API process only). */
export const cacheAdminProviders: Provider[] = [CacheAdminService];
