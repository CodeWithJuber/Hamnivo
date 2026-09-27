import type { Provider } from '@nestjs/common';
import { QUERY_VECTOR_CACHE } from '../knowledge/retrieval.service.js';
import type { PlatformOverrides } from '../platform/platform.module.js';
import { CONFIG } from '../tokens.js';
import { CacheAdminService } from './admin.service.js';
import { AnswerCache } from './answers.js';
import { CacheService } from './cache.service.js';
import {
  CACHE_STORE,
  CACHE_STORE_OVERRIDE,
  CacheConnection,
  CacheExclusions,
  CacheHealth,
  cacheStoreFactory,
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
    CacheExclusions,
    CacheService,
    AnswerCache,
    QueryVectors,
    { provide: QUERY_VECTOR_CACHE, useExisting: QueryVectors },
  ];
}

/** Studio's cache administration (API process only). */
export const cacheAdminProviders: Provider[] = [CacheAdminService];
