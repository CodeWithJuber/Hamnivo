import { createHash } from 'node:crypto';
import type { TenantTx } from '@hamnivo/db';
import { cacheDependency } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  eligiblePassages,
  type Passage,
  type RetrievalCache,
  type SearchInput,
} from '../knowledge/retrieval.service.js';
import { CLOCK, type Clock } from '../tokens.js';
import { CacheService, type CacheSpec } from './cache.service.js';

interface RankedChunk {
  chunkId: string;
  score: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rankedChunks(value: unknown, limit: number): RankedChunk[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item.chunkId !== 'string' ||
      !UUID.test(item.chunkId) ||
      typeof item.score !== 'number' ||
      !Number.isFinite(item.score) ||
      ids.has(item.chunkId)
    )
      return null;
    ids.add(item.chunkId);
  }
  return value as RankedChunk[];
}

/**
 * An opt-in cache of public knowledge rankings, not answers or customer facts. Only chunk IDs
 * and scores are stored. Every hit fetches the current text through the same RLS, source grant,
 * visibility, publication and expiry predicates as a fresh search.
 */
@Injectable()
export class RetrievedPassages implements RetrievalCache {
  constructor(
    private readonly cache: CacheService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async search(
    tx: TenantTx,
    input: SearchInput,
    model: string,
    compute: () => Promise<Passage[]>,
  ): Promise<Passage[]> {
    if (input.audience !== 'customer') return compute();
    const { policy } = await this.cache.policy(tx, input.brandId);
    if (!policy.tiers.retrieval.enabled) return compute();
    const { rows: tenants } = await tx.execute<{ tenant: string }>(
      sql`select app.current_tenant() as tenant`,
    );
    const tenantId = tenants[0]?.tenant;
    if (!tenantId) return compute();
    // The manifest makes new publications and expired/retired sources invalidate even empty
    // results immediately. Cap its size: large libraries can still search normally.
    const { rows: manifest } = await tx.execute<{ source_id: string; version_id: string }>(sql`
      with eligible as (${eligiblePassages(input, this.clock().toISOString())})
      select distinct source_id, version_id from eligible order by source_id, version_id limit 2001
    `);
    if (manifest.length > 2000) return compute();
    const signature = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const sourceIds = [...new Set(manifest.map((row) => row.source_id))].sort();
    const spec = (complete: boolean): CacheSpec => ({
      tier: 'retrieval',
      tenantId,
      brandId: input.brandId,
      audience: 'public',
      language: null,
      model,
      promptVersion: `hybrid-rrf-v1:${signature}`,
      dependencies: [
        cacheDependency.cachePolicy(input.brandId, 'retrieval'),
        ...sourceIds.map(cacheDependency.knowledgeSource),
      ],
      input: JSON.stringify({
        query: input.query.normalize('NFC'),
        sources: input.sourceIds ? [...new Set(input.sourceIds)].sort() : null,
        limit: input.limit,
      }),
      request: {
        tier: 'retrieval',
        dataClasses: ['public_knowledge'],
        texts: [input.query],
        complete,
      },
    });
    const found = await this.cache.lookup<RankedChunk[]>(spec(false));
    if (found.status === 'hit') {
      const ranking = rankedChunks(found.value, input.limit);
      if (ranking) {
        if (ranking.length === 0) return [];
        const { rows } = await tx.execute<{
          id: string;
          document_id: string;
          source_id: string;
          version_id: string;
          version: number;
          title: string;
          url: string | null;
          heading: string | null;
          text: string;
        }>(sql`
          with eligible as (${eligiblePassages(input, this.clock().toISOString())})
          select id, document_id, source_id, version_id, version, title, url, heading, text
          from eligible
          where id in (${sql.join(
            ranking.map((item) => sql`${item.chunkId}::uuid`),
            sql`, `,
          )})
        `);
        const byId = new Map(rows.map((row) => [row.id, row]));
        if (ranking.every((item) => byId.has(item.chunkId))) {
          return ranking.map((item) => {
            const row = byId.get(item.chunkId);
            if (!row) throw new Error('Validated passage disappeared');
            return {
              chunkId: row.id,
              documentId: row.document_id,
              sourceId: row.source_id,
              versionId: row.version_id,
              version: Number(row.version),
              title: row.title,
              url: row.url,
              heading: row.heading,
              text: row.text,
              score: item.score,
            };
          });
        }
      }
      await this.cache.reject(spec(false), found, 'knowledge_changed');
      return compute();
    }
    const passages = await compute();
    if (found.status === 'miss' || found.status === 'stale') {
      await this.cache.put(
        spec(true),
        found,
        passages.map(({ chunkId, score }) => ({ chunkId, score })),
        {
          sources: passages.map(({ documentId, sourceId, title, version }) => ({
            documentId,
            sourceId,
            title,
            version,
          })),
        },
      );
    }
    return passages;
  }
}
