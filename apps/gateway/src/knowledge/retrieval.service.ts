import type { TenantTx } from '@hamnivo/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../tokens.js';
import { EmbeddingFactory } from './embeddings.js';

export interface Passage {
  chunkId: string;
  documentId: string;
  sourceId: string;
  versionId: string;
  version: number;
  title: string;
  url: string | null;
  heading: string | null;
  text: string;
  score: number;
}

export interface SearchInput {
  brandId: string;
  /** Limit to these sources (an agent's knowledge); all of the brand's sources when omitted. */
  sourceIds?: string[];
  /** `customer`: only sources whose answers customers may see (G05). */
  audience: 'customer' | 'staff';
  query: string;
  limit: number;
}

/** Every cache hit and fresh search uses the same live visibility and freshness predicate. */
export function eligiblePassages(input: SearchInput, now: string): SQL {
  return sql`
        select c.id, c.embedding, c.embedding_model, c.search, c.heading, c.text, c.document_id,
               c.source_id, c.version_id, v.version, d.title, d.url
        from knowledge_chunks c
        join document_versions v on v.id = c.version_id and v.state = 'ready'
          and (v.valid_until is null or v.valid_until > ${now}::timestamptz)
        join knowledge_documents d on d.id = c.document_id and d.current_version_id = c.version_id
          and d.status = 'active'
        join knowledge_sources s on s.id = c.source_id and s.status = 'active'
          and s.brand_id = ${input.brandId}::uuid
          and (s.review_every_days is null
               or coalesce(d.reviewed_at, v.ready_at)
                  > ${now}::timestamptz - make_interval(days => s.review_every_days))
        where true
          ${input.audience === 'customer' ? sql`and s.visibility = 'public'` : sql``}
          ${
            input.sourceIds
              ? sql`and c.source_id in (${sql.join(
                  input.sourceIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})`
              : sql``
          }
  `;
}

export const RETRIEVAL_CACHE = Symbol('RETRIEVAL_CACHE');
export interface RetrievalCache {
  search(
    tx: TenantTx,
    input: SearchInput,
    model: string,
    compute: () => Promise<Passage[]>,
  ): Promise<Passage[]>;
}

/**
 * Optional cache for query vectors (K02), provided by the cache module. Eligibility and
 * freshness stay in the search below: a reused vector only finds passages again.
 */
export const QUERY_VECTOR_CACHE = Symbol('QUERY_VECTOR_CACHE');
export interface QueryVectorCache {
  vector(
    tx: TenantTx,
    input: { brandId: string; text: string; model: string; compute: () => Promise<number[]> },
  ): Promise<number[]>;
}

/** Candidates per method before fusion. */
const CANDIDATES = 20;
/** Reciprocal rank fusion constant (Cormack et al., 2009). */
const RRF_K = 60;
/** Query words that carry no meaning on their own, in the product's languages. */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can could do does for from had has have how i if in is it its me my ' +
    'no not of on or our so than that the their them then there these they this to us was we were what ' +
    'when where which who why will with would you your hai hain ka ki ke ko se mein main mera meri kya ' +
    'aur par bhi نہیں ہے ہیں کا کی کے کو سے میں میرا میری کیا اور پر بھی है हैं का की के को से में मेरा ' +
    'मेरी क्या और पर भी في من على إلى عن هل ما و أن هذا هذه'
  ).split(' '),
);

/** Words of a question as an OR query for full-text search (the words, not a phrase). */
export function queryWords(query: string): string[] {
  const words = query
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu);
  return [...new Set(words ?? [])].filter((w) => w.length > 1 && !STOP_WORDS.has(w)).slice(0, 32);
}

/**
 * Hybrid retrieval (G05): vector similarity and full-text match, fused by reciprocal rank. The
 * eligibility filter runs before ranking. It admits only the current ready version of an active
 * document, in an active source of the brand, visible to the audience, not past its end date and
 * reviewed within its source's cycle. Tenant isolation comes from row-level security.
 */
@Injectable()
export class RetrievalService {
  constructor(
    private readonly embeddings: EmbeddingFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(QUERY_VECTOR_CACHE) private readonly vectors?: QueryVectorCache,
    @Optional() @Inject(RETRIEVAL_CACHE) private readonly results?: RetrievalCache,
  ) {}

  private async queryVector(tx: TenantTx, input: SearchInput): Promise<number[]> {
    const compute = async () => (await this.embeddings.embed([input.query]))[0] ?? [];
    if (!this.vectors) return compute();
    return this.vectors.vector(tx, {
      brandId: input.brandId,
      text: input.query,
      model: this.embeddings.id,
      compute,
    });
  }

  async search(tx: TenantTx, input: SearchInput): Promise<Passage[]> {
    if (input.sourceIds && input.sourceIds.length === 0) return [];
    const compute = () => this.freshSearch(tx, input);
    return this.results
      ? this.results.search(
          tx,
          input,
          `${this.embeddings.id}:${this.embeddings.maxDistance}`,
          compute,
        )
      : compute();
  }

  private async freshSearch(tx: TenantTx, input: SearchInput): Promise<Passage[]> {
    if (input.sourceIds && input.sourceIds.length === 0) return [];
    const words = queryWords(input.query);
    const queryVector = await this.queryVector(tx, input);
    const vector = `[${queryVector.join(',')}]`;
    const now = this.clock().toISOString();
    const { rows } = await tx.execute<{
      chunk_id: string;
      document_id: string;
      source_id: string;
      version_id: string;
      version: number;
      title: string;
      url: string | null;
      heading: string | null;
      text: string;
      score: string;
    }>(sql`
      with eligible as (
        ${eligiblePassages(input, now)}
      ),
      by_vector as (
        select id, row_number() over (order by embedding <=> ${vector}::vector) as rank
        from eligible
        where embedding is not null and embedding_model = ${this.embeddings.id}
          and embedding <=> ${vector}::vector < ${this.embeddings.maxDistance}
        order by embedding <=> ${vector}::vector
        limit ${CANDIDATES}
      ),
      by_words as (
        select e.id, row_number() over (order by ts_rank_cd(e.search, q, 1) desc) as rank
        from eligible e, to_tsquery('simple', ${words.join(' | ') || 'hamnivo_no_words'}) q
        where e.search @@ q
        order by ts_rank_cd(e.search, q, 1) desc
        limit ${CANDIDATES}
      )
      select e.id as chunk_id, e.document_id, e.source_id, e.version_id, e.version, e.title,
             e.url, e.heading, e.text,
             coalesce(1.0 / (${RRF_K} + v.rank), 0) + coalesce(1.0 / (${RRF_K} + w.rank), 0)
               as score
      from eligible e
      left join by_vector v on v.id = e.id
      left join by_words w on w.id = e.id
      where v.id is not null or w.id is not null
      order by score desc, e.id
      limit ${input.limit}
    `);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      sourceId: r.source_id,
      versionId: r.version_id,
      version: Number(r.version),
      title: r.title,
      url: r.url,
      heading: r.heading,
      text: r.text,
      score: Number(r.score),
    }));
  }
}
