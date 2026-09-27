import { createHash } from 'node:crypto';
import { appendAudit, newId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import {
  cleanMemoryValue,
  type EvidenceSource,
  evaluateMemoryWrite,
  type MemoryOperation,
  type MemoryRecordPlan,
  type MemoryWriteDecision,
  type MemoryWriter as PolicyWriter,
  type ProposedMemory,
  type TombstoneFact,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';
import { CLOCK, type Clock } from '../tokens.js';
import { MemoryFingerprints } from './fingerprints.js';
import { lockMemorySubject } from './locks.js';
import { type ConsentRow, type MemoryRow, memoryValue, tombstoneFact } from './views.js';

/** The customer a memory is about, and where they belong. */
export interface MemorySubject {
  tenantId: string;
  /** Customer principal UUID. */
  id: string;
  verified: boolean;
  brandId: string;
  workspaceId: string;
}

/** Who acts, for the policy (UUIDs) and for records and audit (public ids). */
export type MemoryActor =
  | { kind: 'extractor'; agentId: string | null }
  | { kind: 'customer' }
  | { kind: 'staff'; staffId: string; authorized: boolean };

export interface WriteResult {
  decision: MemoryWriteDecision;
  /** The record written, activated, reconfirmed or matched; null when refused. */
  record: MemoryRow | null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const contentHashOf = (kind: string, key: string, value: string) =>
  sha256(canonicalize({ kind, key, value }) ?? '');

export function actorRef(
  actor: MemoryActor,
  subject: MemorySubject,
): {
  type: 'customer' | 'staff' | 'ai';
  id: string | null;
} {
  switch (actor.kind) {
    case 'extractor':
      return { type: 'ai', id: actor.agentId };
    case 'customer':
      return { type: 'customer', id: toPublicId('customer', subject.id) };
    case 'staff':
      return { type: 'staff', id: toPublicId('staff', actor.staffId) };
  }
}

/**
 * Applies the memory-write policy (L07) to the database: it loads everything the policy needs
 * (consent, the slot's records, tombstones, counts, fingerprints), asks it, and carries out only
 * what it decided. Callers run it inside withTenant() after `lock()`.
 */
@Injectable()
export class MemoryWriter {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly fingerprints: MemoryFingerprints,
  ) {}

  /** Serializes memory changes for one customer until the transaction ends. */
  lock(tx: TenantTx, subject: MemorySubject): Promise<void> {
    return lockMemorySubject(tx, subject.tenantId, subject.id);
  }

  async latestConsent(tx: TenantTx, subjectId: string): Promise<ConsentRow | null> {
    const c = schema.learningConsents;
    const [row] = await tx
      .select()
      .from(c)
      .where(and(eq(c.subjectId, subjectId), eq(c.scope, 'personal_memory')))
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(1);
    return row ?? null;
  }

  async records(tx: TenantTx, subjectId: string, key?: string): Promise<MemoryRow[]> {
    const r = schema.memoryRecords;
    return tx
      .select()
      .from(r)
      .where(key ? and(eq(r.subjectId, subjectId), eq(r.key, key)) : eq(r.subjectId, subjectId))
      .orderBy(desc(r.version), desc(r.recordedAt));
  }

  async tombstones(tx: TenantTx, subjectId: string): Promise<TombstoneFact[]> {
    const rows = await tx
      .select()
      .from(schema.deletionTombstones)
      .where(eq(schema.deletionTombstones.subjectId, subjectId));
    return rows.map(tombstoneFact);
  }

  private async activeCount(tx: TenantTx, subjectId: string): Promise<number> {
    const r = schema.memoryRecords;
    const [row] = await tx
      .select({ n: count() })
      .from(r)
      .where(and(eq(r.subjectId, subjectId), eq(r.status, 'active')));
    return Number(row?.n ?? 0);
  }

  private async decide(
    tx: TenantTx,
    subject: MemorySubject,
    input: {
      operation: MemoryOperation;
      actor: MemoryActor;
      candidate: ProposedMemory;
      sources?: readonly EvidenceSource[];
      target?: MemoryRow | null;
      validFrom?: Date | null;
      memoryEnabled?: boolean;
      conversationSubjectId?: string | null;
    },
  ): Promise<{ decision: MemoryWriteDecision; slot: MemoryRow[] }> {
    const slot = await this.records(tx, subject.id, input.candidate.key);
    const consent = await this.latestConsent(tx, subject.id);
    const writer: PolicyWriter =
      input.actor.kind === 'extractor'
        ? { kind: 'extractor', agentId: input.actor.agentId }
        : input.actor.kind === 'customer'
          ? { kind: 'customer', principalId: subject.id }
          : { kind: 'staff', staffId: input.actor.staffId, authorized: input.actor.authorized };
    const existing = (row: MemoryRow) => ({
      id: row.id,
      key: row.key,
      value: memoryValue(row),
      status: row.status,
      version: row.version,
      validFrom: row.validFrom,
      observedAt: row.observedAt,
      lastConfirmedAt: row.lastConfirmedAt,
      supersededAt: row.supersededAt,
    });
    const decision = evaluateMemoryWrite({
      operation: input.operation,
      writer,
      subject: { id: subject.id, verified: subject.verified, brandId: subject.brandId },
      context: {
        brandId: subject.brandId,
        memoryEnabled: input.memoryEnabled ?? true,
        conversationSubjectId: input.conversationSubjectId ?? null,
      },
      consent: consent
        ? { state: consent.state, decidedAt: consent.createdAt }
        : { state: 'none', decidedAt: null },
      candidate: input.candidate,
      sources: input.sources ?? [],
      existing: slot.map(existing),
      target: input.target ? existing(input.target) : null,
      activeCount: await this.activeCount(tx, subject.id),
      tombstones: await this.tombstones(tx, subject.id),
      fingerprints: this.fingerprints.all(
        subject.tenantId,
        subject.id,
        cleanMemoryValue(input.candidate.value ?? ''),
      ),
      now: this.clock(),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    });
    return { decision, slot };
  }

  private async insert(
    tx: TenantTx,
    subject: MemorySubject,
    plan: MemoryRecordPlan,
    extra: {
      id?: string;
      /** Who wrote it, by public id (the policy works with internal ids). */
      writer: ReturnType<typeof actorRef>;
      policyVersion: string;
      version: number;
      supersedesId: string | null;
      conversationId: string | null;
      note?: string | null;
      reviewedBy?: string | null;
    },
  ): Promise<MemoryRow> {
    const now = this.clock();
    const confirmed = plan.reviewStatus === 'confirmed';
    const [row] = await tx
      .insert(schema.memoryRecords)
      .values({
        ...(extra.id ? { id: extra.id } : {}),
        tenantId: subject.tenantId,
        workspaceId: subject.workspaceId,
        brandId: subject.brandId,
        subjectId: subject.id,
        conversationId: extra.conversationId,
        scope: plan.scope,
        kind: plan.kind,
        key: plan.key,
        payload: { value: plan.value },
        contentHash: contentHashOf(plan.kind, plan.key, plan.value),
        sourceType: plan.sourceType,
        sourceEventIds: plan.sourceEventIds,
        evidenceStatus: plan.evidenceStatus,
        writtenByType: extra.writer.type,
        writtenById: extra.writer.id,
        writeReason: plan.writeReason,
        writeNote: extra.note ?? null,
        purpose: plan.purpose,
        allowedPurposes: plan.allowedPurposes,
        allowedRoles: plan.allowedRoles,
        sensitivity: plan.sensitivity,
        retentionClass: plan.retentionClass,
        expiresAt: plan.expiresAt,
        policyVersion: extra.policyVersion,
        status: plan.status,
        reviewStatus: plan.reviewStatus,
        reviewedBy: confirmed ? (extra.reviewedBy ?? null) : null,
        reviewedAt: confirmed ? now : null,
        confidence: plan.confidence,
        version: extra.version,
        supersedesId: extra.supersedesId,
        observedAt: plan.observedAt,
        validFrom: plan.validFrom,
        recordedAt: now,
        lastConfirmedAt: confirmed ? now : null,
      })
      .returning();
    if (!row) throw new Error('memory insert returned nothing');
    if (row.status === 'active') await this.index(tx, row);
    return row;
  }

  /** Queues the record's vector for recall (G19); the worker computes it. */
  private async index(tx: TenantTx, row: MemoryRow): Promise<void> {
    await enqueueOutbox(tx, row.tenantId, {
      topic: 'memory.embed',
      aggregateType: 'memory',
      aggregateId: row.id,
      payload: { memoryId: row.id },
    });
  }

  /** Ends a record's validity: superseded by `next` (or outdated), and drops its vectors. */
  private async close(
    tx: TenantTx,
    row: MemoryRow,
    change: { status: 'superseded' | 'outdated'; validUntil: Date; nextId?: string },
  ): Promise<MemoryRow> {
    const now = this.clock();
    const [closed] = await tx
      .update(schema.memoryRecords)
      .set({
        status: change.status,
        validUntil: change.validUntil < row.validFrom ? row.validFrom : change.validUntil,
        supersededAt: now,
        ...(change.nextId ? { supersededById: change.nextId } : {}),
        updatedAt: now,
      })
      .where(eq(schema.memoryRecords.id, row.id))
      .returning();
    await tx.delete(schema.memoryEmbeddings).where(eq(schema.memoryEmbeddings.memoryId, row.id));
    if (!closed) throw new Error('memory update returned nothing');
    return closed;
  }

  /** The value was stated or confirmed again at `at` (the evidence's time for proposals). */
  private async reconfirm(tx: TenantTx, id: string, at: Date): Promise<MemoryRow | null> {
    const r = schema.memoryRecords;
    const [row] = await tx
      .update(r)
      .set({
        lastConfirmedAt: sql`greatest(${r.lastConfirmedAt}, ${at.toISOString()}::timestamptz)`,
        updatedAt: this.clock(),
      })
      .where(and(eq(r.id, id), eq(r.status, 'active')))
      .returning();
    if (row) return row;
    const [pending] = await tx
      .select()
      .from(schema.memoryRecords)
      .where(eq(schema.memoryRecords.id, id));
    return pending ?? null;
  }

  private nextVersion(slot: readonly MemoryRow[]): number {
    return slot.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  }

  private async audit(
    tx: TenantTx,
    subject: MemorySubject,
    actor: MemoryActor,
    action: string,
    decision: MemoryWriteDecision,
    record: MemoryRow | null,
  ) {
    const ref = actorRef(actor, subject);
    await appendAudit(tx, {
      actorType: ref.type,
      actorId: ref.id,
      action,
      targetType: 'memory',
      targetId: record ? toPublicId('memory', record.id) : toPublicId('customer', subject.id),
      outcome: decision.outcome === 'refuse' ? 'denied' : 'success',
      data: {
        customerId: toPublicId('customer', subject.id),
        key: record?.key ?? null,
        outcome: decision.outcome,
        policyVersion: decision.policyVersion,
        refusals: decision.refusals,
      },
    });
  }

  /** A proposal from the conversational model (extraction). */
  async propose(
    tx: TenantTx,
    subject: MemorySubject,
    input: {
      agentId: string | null;
      candidate: ProposedMemory;
      sources: readonly EvidenceSource[];
      memoryEnabled: boolean;
      conversationId: string;
      conversationSubjectId: string | null;
    },
  ): Promise<WriteResult> {
    const actor: MemoryActor = { kind: 'extractor', agentId: input.agentId };
    const { decision, slot } = await this.decide(tx, subject, {
      operation: 'propose',
      actor,
      candidate: input.candidate,
      sources: input.sources,
      memoryEnabled: input.memoryEnabled,
      conversationSubjectId: input.conversationSubjectId,
    });
    let record: MemoryRow | null = null;
    switch (decision.outcome) {
      case 'write':
      case 'review':
        if (!decision.record) break;
        record = await this.insert(tx, subject, decision.record, {
          writer: actorRef(actor, subject),
          policyVersion: decision.policyVersion,
          version: this.nextVersion(slot),
          supersedesId: null,
          conversationId: input.conversationId,
        });
        await this.audit(
          tx,
          subject,
          actor,
          decision.outcome === 'write' ? 'memory.written' : 'memory.review_queued',
          decision,
          record,
        );
        break;
      case 'unchanged':
        record = decision.relatedId
          ? await this.reconfirm(tx, decision.relatedId, decision.evidenceAt ?? this.clock())
          : null;
        break;
      default:
        break;
    }
    return { decision, record };
  }

  /** A correction by the customer or staff: the new value supersedes the target. */
  async correct(
    tx: TenantTx,
    subject: MemorySubject,
    input: {
      actor: Exclude<MemoryActor, { kind: 'extractor' }>;
      target: MemoryRow;
      value: string;
      note?: string | null;
      validFrom?: Date | null;
    },
  ): Promise<WriteResult> {
    const { decision } = await this.decide(tx, subject, {
      operation: 'correct',
      actor: input.actor,
      candidate: { key: input.target.key, value: input.value },
      target: input.target,
      validFrom: input.validFrom ?? null,
    });
    if (decision.outcome === 'refuse') {
      await this.audit(tx, subject, input.actor, 'memory.corrected', decision, input.target);
      return { decision, record: null };
    }
    if (decision.outcome === 'unchanged' || !decision.record) {
      return { decision, record: await this.reconfirm(tx, input.target.id, this.clock()) };
    }
    const nextId = newId();
    await this.close(tx, input.target, {
      status: 'superseded',
      validUntil: decision.record.validFrom,
      nextId,
    });
    const ref = actorRef(input.actor, subject);
    const record = await this.insert(tx, subject, decision.record, {
      id: nextId,
      writer: ref,
      policyVersion: decision.policyVersion,
      version: input.target.version + 1,
      supersedesId: input.target.id,
      conversationId: input.target.conversationId,
      note: input.note ?? null,
      reviewedBy: `${ref.type}:${ref.id}`,
    });
    await this.audit(tx, subject, input.actor, 'memory.corrected', decision, record);
    return { decision, record };
  }

  /** Confirms a value that waits for review: it becomes current and supersedes the old one. */
  async confirm(
    tx: TenantTx,
    subject: MemorySubject,
    input: { actor: Exclude<MemoryActor, { kind: 'extractor' }>; target: MemoryRow },
  ): Promise<WriteResult> {
    const { decision, slot } = await this.decide(tx, subject, {
      operation: 'confirm',
      actor: input.actor,
      candidate: { key: input.target.key, value: memoryValue(input.target) },
      target: input.target,
    });
    if (decision.outcome === 'refuse') {
      await this.audit(tx, subject, input.actor, 'memory.confirmed', decision, input.target);
      return { decision, record: null };
    }
    const now = this.clock();
    const current = slot.find((row) => row.id === decision.relatedId) ?? null;
    if (current) {
      await this.close(tx, current, {
        status: 'superseded',
        validUntil: input.target.validFrom,
        nextId: input.target.id,
      });
    }
    const ref = actorRef(input.actor, subject);
    const [record] = await tx
      .update(schema.memoryRecords)
      .set({
        status: 'active',
        reviewStatus: 'confirmed',
        reviewedBy: `${ref.type}:${ref.id}`,
        reviewedAt: now,
        lastConfirmedAt: now,
        version: current ? current.version + 1 : input.target.version,
        supersedesId: current?.id ?? null,
        updatedAt: now,
      })
      .where(eq(schema.memoryRecords.id, input.target.id))
      .returning();
    if (!record) throw new Error('memory confirm returned nothing');
    await this.index(tx, record);
    await this.audit(tx, subject, input.actor, 'memory.confirmed', decision, record);
    return { decision, record };
  }

  /** Stops using a value without replacing it ("mark outdated"). No new content is written. */
  async outdate(
    tx: TenantTx,
    subject: MemorySubject,
    input: { actor: Exclude<MemoryActor, { kind: 'extractor' }>; target: MemoryRow },
  ): Promise<MemoryRow> {
    const record = await this.close(tx, input.target, {
      status: 'outdated',
      validUntil: this.clock(),
    });
    const ref = actorRef(input.actor, subject);
    await appendAudit(tx, {
      actorType: ref.type,
      actorId: ref.id,
      action: 'memory.outdated',
      targetType: 'memory',
      targetId: toPublicId('memory', record.id),
      outcome: 'success',
      data: { customerId: toPublicId('customer', subject.id), key: record.key },
    });
    return record;
  }

  /** Records of these ids that belong to the subject. */
  async byIds(tx: TenantTx, subjectId: string, ids: readonly string[]): Promise<MemoryRow[]> {
    if (ids.length === 0) return [];
    const r = schema.memoryRecords;
    return tx
      .select()
      .from(r)
      .where(and(eq(r.subjectId, subjectId), inArray(r.id, [...ids])));
  }
}
