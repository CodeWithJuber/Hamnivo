import type { TenantTx } from '@hamnivo/db';
import { EMBEDDING_DIMENSIONS } from '@hamnivo/db/schema';
import { cacheDependency } from '@hamnivo/domain';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { QueryVectorCache } from '../knowledge/retrieval.service.js';
import { CacheService, type CacheSpec } from './cache.service.js';

/** Bump when the text given to the embedding model is prepared differently. */
const PREPROCESSING = 'query-v1';

function encode(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function decode(value: string): number[] | null {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== EMBEDDING_DIMENSIONS * 4) return null;
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, EMBEDDING_DIMENSIONS));
}

/**
 * The embedding cache for search queries (K02): the vector is bound to the exact text, the
 * embedding model, its dimensions and the preprocessing version. A reused vector only finds
 * passages again; eligibility, permissions and freshness are still applied by the search itself.
 * Queries with personal data are never cached.
 */
@Injectable()
export class QueryVectors implements QueryVectorCache {
  constructor(private readonly cache: CacheService) {}

  async vector(
    tx: TenantTx,
    input: { brandId: string; text: string; model: string; compute: () => Promise<number[]> },
  ): Promise<number[]> {
    const { rows } = await tx.execute<{ tenant: string }>(
      sql`select app.current_tenant() as tenant`,
    );
    const tenantId = rows[0]?.tenant;
    if (!tenantId) return input.compute();
    const spec = (complete: boolean): CacheSpec => ({
      tier: 'embedding',
      tenantId,
      brandId: input.brandId,
      audience: 'public',
      language: null,
      model: input.model,
      promptVersion: `${PREPROCESSING}:${EMBEDDING_DIMENSIONS}`,
      dependencies: [cacheDependency.cachePolicy(input.brandId, 'embedding')],
      input: input.text.normalize('NFC'),
      request: { tier: 'embedding', dataClasses: ['general'], texts: [input.text], complete },
    });
    const found = await this.cache.lookup<string>(spec(false));
    if (found.status === 'hit') {
      const vector = decode(found.value);
      if (vector) return vector;
    }
    if (found.status !== 'miss' && found.status !== 'stale') return input.compute();
    // Concurrent searches for the same text embed it once.
    const vector = await this.cache.coalesce(found.key.key, input.compute);
    if (vector.length === EMBEDDING_DIMENSIONS)
      await this.cache.put(spec(true), found, encode(vector));
    return vector;
  }
}
