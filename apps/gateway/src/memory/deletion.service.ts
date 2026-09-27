import {
  appendAudit,
  applyMemoryTombstones,
  type ClaimedOutboxEvent,
  type Db,
  expiredMemorySubjects,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { MemoryCache } from './cache.js';
import { MemoryFingerprints } from './fingerprints.js';
import { lockMemorySubject } from './locks.js';
import { type DeletionRow, type MemoryRow, memoryValue } from './views.js';

export interface DeletionRequest {
  subject: { tenantId: string; id: string; brandId: string };
  records: readonly MemoryRow[];
  /** `customer`: everything about the customer was erased (a subject tombstone is added). */
  scope: 'record' | 'customer';
  reason: DeletionRow['reason'];
  requestedBy: { type: 'customer' | 'staff' | 'system'; id: string | null };
}

const PENDING_STEPS = {
  records: 'pending',
  embeddings: 'pending',
  citations: 'pending',
  caches: 'pending',
  verification: 'pending',
} as const;

/**
 * Deletion propagation (L05, K09). In one transaction a deletion writes its receipt and content-free
 * tombstones, removes the records, their vectors and the memory citations on published answers
 * and in the realtime journal. The worker then purges per-customer caches, verifies that nothing
 * the tombstones cover is left, and only then marks the receipt completed.
 */
@Injectable()
export class MemoryDeletionService {
  private readonly logger = new Logger(MemoryDeletionService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly fingerprints: MemoryFingerprints,
    private readonly cache: MemoryCache,
  ) {}

  /** Deletes inside the caller's transaction (which holds the customer's memory lock). */
  async delete(tx: TenantTx, request: DeletionRequest): Promise<DeletionRow> {
    const { subject, records } = request;
    const now = this.clock();
    const [receipt] = await tx
      .insert(schema.memoryDeletions)
      .values({
        tenantId: subject.tenantId,
        brandId: subject.brandId,
        subjectId: subject.id,
        scope: request.scope,
        reason: request.reason,
        requestedByType: request.requestedBy.type,
        requestedById: request.requestedBy.id,
        recordCount: records.length,
        steps: { ...PENDING_STEPS },
        createdAt: now,
      })
      .returning();
    if (!receipt) throw new Error('deletion insert returned nothing');

    const tombstones: (typeof schema.deletionTombstones.$inferInsert)[] = records.map((row) => ({
      tenantId: subject.tenantId,
      deletionId: receipt.id,
      subjectId: subject.id,
      targetType: 'memory_record',
      targetId: row.id,
      memoryKey: row.key,
      sourceEventIds: row.sourceEventIds,
      fingerprints: [this.fingerprints.current(subject.tenantId, subject.id, memoryValue(row))],
      observedAt: row.observedAt,
      createdAt: now,
    }));
    if (request.scope === 'customer') {
      tombstones.push({
        tenantId: subject.tenantId,
        deletionId: receipt.id,
        subjectId: subject.id,
        targetType: 'memory_subject',
        targetId: subject.id,
        memoryKey: null,
        sourceEventIds: [],
        fingerprints: [],
        observedAt: now,
        createdAt: now,
      });
    }
    if (tombstones.length > 0) {
      await tx.insert(schema.deletionTombstones).values(tombstones).onConflictDoNothing();
    }

    const ids = records.map((row) => row.id);
    if (ids.length > 0) {
      await tx
        .delete(schema.memoryEmbeddings)
        .where(inArray(schema.memoryEmbeddings.memoryId, ids));
      // One statement, so links between versions of a slot never point at a deleted row midway.
      await tx.delete(schema.memoryRecords).where(inArray(schema.memoryRecords.id, ids));
      await this.scrubCitations(
        tx,
        subject.id,
        ids.map((id) => toPublicId('memory', id)),
      );
    }
    const [updated] = await tx
      .update(schema.memoryDeletions)
      .set({
        steps: { ...PENDING_STEPS, records: 'done', embeddings: 'done', citations: 'done' },
      })
      .where(eq(schema.memoryDeletions.id, receipt.id))
      .returning();
    await enqueueOutbox(tx, subject.tenantId, {
      topic: 'memory.deleted',
      aggregateType: 'memory_deletion',
      aggregateId: receipt.id,
      payload: { deletionId: receipt.id },
    });
    await appendAudit(tx, {
      actorType: request.requestedBy.type,
      actorId: request.requestedBy.id,
      action: request.scope === 'customer' ? 'memory.erased' : 'memory.deleted',
      targetType: 'memory_deletion',
      targetId: toPublicId('memoryDeletion', receipt.id),
      outcome: 'success',
      data: {
        customerId: toPublicId('customer', subject.id),
        reason: request.reason,
        records: records.length,
        keys: [...new Set(records.map((row) => row.key))],
      },
    });
    return updated ?? receipt;
  }

  /**
   * Removes citations of deleted memories from the customer's published answers and from the
   * realtime journal, so no reply points at a memory that no longer exists.
   */
  private async scrubCitations(tx: TenantTx, subjectId: string, memoryIds: string[]) {
    const ids = sql`array[${sql.join(
      memoryIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const conversations = sql`(select c.id from conversation_controls c where c.principal_id = ${subjectId}::uuid)`;
    await tx.execute(sql`
      update publications p
      set detail = jsonb_set(p.detail, '{memories}', coalesce((
            select jsonb_agg(m.part order by m.n)
            from jsonb_array_elements(p.detail->'memories') with ordinality as m(part, n)
            where not (m.part->>'memoryId' = any(${ids}))
          ), '[]'::jsonb)),
          updated_at = now()
      where p.conversation_id in ${conversations}
        and jsonb_typeof(p.detail->'memories') = 'array'`);
    await tx.execute(sql`
      update conversation_journal j
      set event = jsonb_set(j.event, '{data,message,parts}', coalesce((
            select jsonb_agg(m.part order by m.n)
            from jsonb_array_elements(j.event->'data'->'message'->'parts') with ordinality as m(part, n)
            where not (m.part->>'type' = 'memory' and m.part->>'memoryId' = any(${ids}))
          ), '[]'::jsonb))
      where j.conversation_id in ${conversations}
        and j.event->'data'->'message'->'parts' @> '[{"type":"memory"}]'::jsonb`);
  }

  /**
   * Outbox handler for `memory.deleted`: purges the customer's caches, verifies that nothing the
   * deletion's tombstones cover is left (replaying them if needed), then completes the receipt.
   */
  async complete(event: ClaimedOutboxEvent): Promise<void> {
    const { deletionId } = event.payload as { deletionId: string };
    const tenantId = event.tenantId;
    const receipt = await withTenant(this.db, { tenantId, actorId: 'system' }, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.memoryDeletions)
        .where(eq(schema.memoryDeletions.id, deletionId));
      return row ?? null;
    });
    if (!receipt || receipt.status === 'completed') return;
    let left = await this.remaining(tenantId, deletionId);
    if (left > 0) {
      // Something came back after the deletion (a replay or a restore): remove it again.
      await applyMemoryTombstones(this.db);
      left = await this.remaining(tenantId, deletionId);
    }
    if (left > 0) throw new Error(`memory deletion ${deletionId} is not complete yet`);
    await this.cache.purge(tenantId, receipt.subjectId);
    await withTenant(this.db, { tenantId, actorId: 'system' }, (tx) =>
      tx
        .update(schema.memoryDeletions)
        .set({
          status: 'completed',
          completedAt: this.clock(),
          steps: {
            records: 'done',
            embeddings: 'done',
            citations: 'done',
            caches: 'done',
            verification: 'done',
          },
        })
        .where(eq(schema.memoryDeletions.id, deletionId)),
    );
  }

  /** Records and vectors still covered by one deletion's tombstones. */
  private async remaining(tenantId: string, deletionId: string): Promise<number> {
    return withTenant(this.db, { tenantId, actorId: 'system' }, async (tx) => {
      const { rows } = await tx.execute<{ n: string }>(sql`
        select (
          select count(*) from memory_records r
          join deletion_tombstones t on t.deletion_id = ${deletionId}::uuid
          where (t.target_type = 'memory_record' and t.target_id = r.id)
             or (t.target_type = 'memory_subject' and t.target_id = r.subject_id
                 and r.observed_at <= t.observed_at)
        ) + (
          select count(*) from memory_embeddings e
          join deletion_tombstones t on t.deletion_id = ${deletionId}::uuid
            and t.target_type = 'memory_record' and t.target_id = e.memory_id
        ) as n`);
      return Number(rows[0]?.n ?? 0);
    });
  }

  /** Maintenance: deletes memory past its retention, with the same receipts and tombstones. */
  async purgeExpired(limit = 200): Promise<number> {
    let removed = 0;
    for (const found of await expiredMemorySubjects(this.db, limit)) {
      const deletion = await withTenant(
        this.db,
        { tenantId: found.tenantId, actorId: 'system' },
        async (tx) => {
          await lockMemorySubject(tx, found.tenantId, found.subjectId);
          const expired = await tx
            .select()
            .from(schema.memoryRecords)
            .where(
              and(
                eq(schema.memoryRecords.subjectId, found.subjectId),
                lte(schema.memoryRecords.expiresAt, this.clock()),
              ),
            );
          if (expired.length === 0) return null;
          return this.delete(tx, {
            subject: { tenantId: found.tenantId, id: found.subjectId, brandId: found.brandId },
            records: expired,
            scope: 'record',
            reason: 'retention_expired',
            requestedBy: { type: 'system', id: null },
          });
        },
      );
      removed += deletion?.recordCount ?? 0;
    }
    if (removed > 0) this.logger.log(`memory past its retention deleted: ${removed} records`);
    return removed;
  }

  /** Maintenance: replays every tombstone, as after a restore. */
  async replayTombstones(): Promise<number> {
    return applyMemoryTombstones(this.db);
  }
}
