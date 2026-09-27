import type { MemoryConsent, MemoryDeletionReceipt, MemoryItem } from '@hamnivo/contracts';
import { schema, toPublicId } from '@hamnivo/db';
import type { TombstoneFact } from '@hamnivo/domain';
import { iso } from '../common/views.js';

export type MemoryRow = typeof schema.memoryRecords.$inferSelect;
export type ConsentRow = typeof schema.learningConsents.$inferSelect;
export type DeletionRow = typeof schema.memoryDeletions.$inferSelect;
export type TombstoneRow = typeof schema.deletionTombstones.$inferSelect;

/** Who is looking: customers see their own memory without staff names or notes. */
export type Audience = 'customer' | 'staff';

export const memoryValue = (row: Pick<MemoryRow, 'payload'>): string => row.payload?.value ?? '';

export function memoryItemView(
  row: MemoryRow,
  options: {
    audience: Audience;
    /** The current value a pending one disagrees with. */
    conflictsWith?: string | null;
    /** Display names of writers by their public id (staff audience). */
    names?: ReadonlyMap<string, string>;
  },
): MemoryItem {
  const staff = options.audience === 'staff';
  const writerId = staff ? row.writtenById : null;
  return {
    id: toPublicId('memory', row.id),
    customerId: toPublicId('customer', row.subjectId),
    brandId: toPublicId('brand', row.brandId),
    key: row.key,
    kind: row.kind,
    value: memoryValue(row),
    status: row.status,
    reviewStatus: row.reviewStatus,
    scope: row.scope === 'conversation' ? 'conversation' : 'person',
    purpose: row.purpose,
    sensitivity: row.sensitivity,
    evidenceStatus: row.evidenceStatus,
    source: {
      type: row.sourceType,
      messageIds: row.sourceEventIds,
      conversationId: row.conversationId ? toPublicId('conversation', row.conversationId) : null,
      observedAt: row.observedAt.toISOString(),
    },
    writtenBy: {
      type: row.writtenByType,
      id: writerId,
      name: writerId ? (options.names?.get(writerId) ?? null) : null,
    },
    reason: row.writeReason as MemoryItem['reason'],
    note: staff ? row.writeNote : null,
    version: row.version,
    supersedes: row.supersedesId ? toPublicId('memory', row.supersedesId) : null,
    supersededBy: row.supersededById ? toPublicId('memory', row.supersededById) : null,
    conflictsWith: options.conflictsWith ? toPublicId('memory', options.conflictsWith) : null,
    validFrom: row.validFrom.toISOString(),
    validUntil: iso(row.validUntil),
    expiresAt: iso(row.expiresAt),
    recordedAt: row.recordedAt.toISOString(),
    supersededAt: iso(row.supersededAt),
    lastConfirmedAt: iso(row.lastConfirmedAt),
    reviewedAt: iso(row.reviewedAt),
    policyVersion: row.policyVersion,
  };
}

/** Current and pending values, each pending one linked to the value it disagrees with. */
export function currentItems(
  rows: readonly MemoryRow[],
  audience: Audience,
  names?: ReadonlyMap<string, string>,
): MemoryItem[] {
  const active = new Map(rows.filter((r) => r.status === 'active').map((r) => [r.key, r.id]));
  return rows
    .filter((r) => r.status === 'active' || r.status === 'pending')
    .sort((a, b) => a.key.localeCompare(b.key) || a.status.localeCompare(b.status))
    .map((row) =>
      memoryItemView(row, {
        audience,
        conflictsWith: row.status === 'pending' ? (active.get(row.key) ?? null) : null,
        ...(names ? { names } : {}),
      }),
    );
}

export function consentView(row: ConsentRow | null | undefined): MemoryConsent {
  return row
    ? { state: row.state, decidedAt: row.createdAt.toISOString(), noticeVersion: row.noticeVersion }
    : { state: 'undecided', decidedAt: null, noticeVersion: null };
}

const STEPS = ['records', 'embeddings', 'citations', 'caches', 'verification'] as const;

export function receiptView(
  row: DeletionRow,
  audience: Audience,
  names?: ReadonlyMap<string, string>,
): MemoryDeletionReceipt {
  const requester = audience === 'staff' ? row.requestedById : null;
  return {
    id: toPublicId('memoryDeletion', row.id),
    scope: row.scope,
    reason: row.reason,
    status: row.status,
    records: row.recordCount,
    steps: STEPS.map((step) => ({ step, status: row.steps[step] === 'done' ? 'done' : 'pending' })),
    kept:
      row.scope === 'customer'
        ? ['audit_log', 'consent_log', 'deletion_record', 'chat_history']
        : ['audit_log', 'deletion_record', 'chat_history'],
    requestedBy: {
      type: row.requestedByType,
      id: requester,
      name: requester ? (names?.get(requester) ?? null) : null,
    },
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

export function tombstoneFact(row: TombstoneRow): TombstoneFact {
  return {
    scope: row.targetType === 'memory_subject' ? 'subject' : 'record',
    key: row.memoryKey,
    sourceRefs: row.sourceEventIds,
    fingerprints: row.fingerprints,
    deletedAt: row.createdAt,
  };
}
