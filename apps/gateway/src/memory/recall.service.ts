import { createHash } from 'node:crypto';
import type { AgentConfig } from '@hamnivo/contracts';
import { type Db, schema, toPublicId, withTenant } from '@hamnivo/db';
import {
  type AuthorityMessage,
  type RecallCandidate,
  selectRecall,
  sharedCacheEligibility,
} from '@hamnivo/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ControlRow } from '../authority/ownership.service.js';
import { EmbeddingFactory } from '../knowledge/embeddings.js';
import { queryWords } from '../knowledge/retrieval.service.js';
import { RunsService, type StepInput } from '../runtime/runs.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { MemoryCache } from './cache.js';

export interface RecalledMemory extends RecallCandidate {
  publicId: string;
}

/** Reciprocal rank fusion constant, as for knowledge. */
const RRF_K = 60;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Customer memory in AI replies (G19). Only for an agent that uses memory, a customer who agreed,
 * the conversation's own customer and brand, current values that allow AI replies, nothing under
 * review and nothing a deletion covers; then ranked like knowledge (vectors and words, fused by
 * rank) and cut to the agent's budget. The run records counts and a snapshot hash, never the
 * memories themselves.
 */
@Injectable()
export class MemoryRecallService {
  private readonly logger = new Logger(MemoryRecallService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly embeddings: EmbeddingFactory,
    private readonly runs: RunsService,
    private readonly cache: MemoryCache,
  ) {}

  private step(tenantId: string, runId: string, input: Omit<StepInput, 'kind' | 'name'>) {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, (tx) =>
      this.runs.step(tx, tenantId, runId, { kind: 'retrieval', name: 'memory', ...input }),
    );
  }

  async recall(
    tenantId: string,
    input: { runId: string; control: ControlRow; config: AgentConfig; history: AuthorityMessage[] },
  ): Promise<RecalledMemory[]> {
    const { control, config, runId } = input;
    if (!config.memory.enabled) return [];
    const subjectId = control.principalId;
    const brandId = control.brandId;
    if (!subjectId || !brandId) {
      await this.step(tenantId, runId, { status: 'skipped', detail: { reason: 'no_customer' } });
      return [];
    }
    const consent = await withTenant(this.db, { tenantId, actorId: 'ai' }, async (tx) => {
      const c = schema.learningConsents;
      const [row] = await tx
        .select({ state: c.state })
        .from(c)
        .where(and(eq(c.subjectId, subjectId), eq(c.scope, 'personal_memory')))
        .orderBy(desc(c.createdAt), desc(c.id))
        .limit(1);
      return row?.state ?? 'none';
    });
    if (consent !== 'granted') {
      await this.step(tenantId, runId, { status: 'skipped', detail: { reason: 'no_consent' } });
      return [];
    }

    const query = input.history
      .filter((m) => m.direction === 'incoming' && !m.private && m.text?.trim())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(-2)
      .map((m) => (m.text ?? '').trim())
      .join('\n')
      .slice(-1000);
    let vector: number[] | null = null;
    if (query) {
      try {
        vector = (await this.embeddings.embed([query]))[0] ?? null;
      } catch (error) {
        // Without a vector, recall still ranks by words and profile; replies never wait on it.
        this.logger.warn(`memory recall without vectors: ${(error as Error).name}`);
      }
    }
    const started = Date.now();
    const now = this.clock();
    const at = sql`${now.toISOString()}::timestamptz`;
    const words = queryWords(query);
    const candidates = await withTenant(this.db, { tenantId, actorId: 'ai' }, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        key: string;
        kind: RecallCandidate['kind'];
        payload: { value?: string };
        status: RecallCandidate['status'];
        version: number;
        valid_from: Date;
        valid_until: Date | null;
        expires_at: Date | null;
        recorded_at: Date;
        superseded_at: Date | null;
        supersedes_id: string | null;
        superseded_by_id: string | null;
        source_type: RecallCandidate['sourceType'];
        evidence_status: RecallCandidate['evidenceStatus'];
        observed_at: Date;
        score: string;
      }>(sql`
        with eligible as (
          select r.* from memory_records r
          where r.subject_id = ${subjectId}::uuid and r.brand_id = ${brandId}::uuid
            and r.status = 'active'
            and r.valid_from <= ${at} and (r.valid_until is null or r.valid_until > ${at})
            and (r.expires_at is null or r.expires_at > ${at})
            and 'ai_replies' = any(r.allowed_purposes) and 'ai' = any(r.allowed_roles)
            and (r.scope = 'person'
                 or (r.scope = 'conversation' and r.conversation_id = ${control.id}::uuid))
            and not exists (
              select from memory_records p
              where p.subject_id = r.subject_id and p.key = r.key and p.status = 'pending')
            -- A row a restore brought back is never used, even before the tombstones are replayed.
            and not exists (
              select from deletion_tombstones t
              where t.subject_id = r.subject_id
                and ((t.target_type = 'memory_record' and t.target_id = r.id)
                  or (t.target_type = 'memory_subject' and r.observed_at <= t.observed_at)))
        ),
        by_vector as (
          ${
            vector
              ? sql`select e.memory_id as id,
                       row_number() over (order by e.embedding <=> ${`[${vector.join(',')}]`}::vector) as rank
                    from memory_embeddings e join eligible x on x.id = e.memory_id
                    where e.embedding_model = ${this.embeddings.id} and e.content_hash = x.content_hash`
              : sql`select null::uuid as id, null::bigint as rank where false`
          }
        ),
        by_words as (
          select x.id, row_number() over (order by ts_rank_cd(x.search, q, 1) desc) as rank
          from eligible x, to_tsquery('simple', ${words.join(' | ') || 'hamnivo_no_words'}) q
          where x.search @@ q
        )
        select x.id, x.key, x.kind, x.payload, x.status, x.version, x.valid_from, x.valid_until,
               x.expires_at, x.recorded_at, x.superseded_at, x.supersedes_id, x.superseded_by_id,
               x.source_type, x.evidence_status, x.observed_at,
               coalesce(1.0 / (${RRF_K} + v.rank), 0) + coalesce(1.0 / (${RRF_K} + w.rank), 0)
                 as score
        from eligible x
        left join by_vector v on v.id = x.id
        left join by_words w on w.id = x.id`);
      return rows.map(
        (row): RecalledMemory => ({
          id: row.id,
          publicId: toPublicId('memory', row.id),
          key: row.key,
          kind: row.kind,
          value: row.payload?.value ?? '',
          status: row.status,
          version: Number(row.version),
          validFrom: new Date(row.valid_from),
          validUntil: row.valid_until ? new Date(row.valid_until) : null,
          expiresAt: row.expires_at ? new Date(row.expires_at) : null,
          recordedAt: new Date(row.recorded_at),
          supersededAt: row.superseded_at ? new Date(row.superseded_at) : null,
          supersedesId: row.supersedes_id,
          supersededById: row.superseded_by_id,
          sourceType: row.source_type,
          evidenceStatus: row.evidence_status,
          observedAt: new Date(row.observed_at),
          score: Number(row.score),
        }),
      );
    });
    const selection = selectRecall(
      candidates,
      { maxItems: config.memory.maxItems, maxChars: config.memory.maxChars },
      now,
    );
    const snapshot = sha256(
      selection.items
        .map((item) => `${item.id}:${item.version}`)
        .sort()
        .join(','),
    )
      .toString('hex')
      .slice(0, 16);
    await this.step(tenantId, runId, {
      status: 'ok',
      latencyMs: Date.now() - started,
      ...(query ? { inputHash: sha256(query) } : {}),
      detail: {
        items: selection.items.length,
        withheld: selection.withheld,
        snapshot,
        memoryVersion: await this.cache.version(tenantId, subjectId).catch(() => null),
        sharedCache: sharedCacheEligibility({ memoryItems: selection.items.length }),
      },
    });
    return selection.items;
  }
}
