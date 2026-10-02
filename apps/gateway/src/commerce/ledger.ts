import { schema, type TenantTx } from '@hamnivo/db';
import { nextState, type OperationState, operationMachine } from '@hamnivo/domain/commerce';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { CommerceActor } from './common.js';

export type OperationRow = typeof schema.operations.$inferSelect;
export type ReceiptRow = typeof schema.operationReceipts.$inferSelect;

export interface NewOperation {
  tenantId: string;
  /** Commerce writes, and AI tool actions (`tool.<name>`) since one ledger serves both. */
  kind: 'commerce.checkout.create' | 'commerce.refund.create' | `tool.${string}`;
  businessKey: string;
  requestHash: Buffer;
  provider: string;
  resourceType: 'purchase_intent' | 'refund' | 'action';
  resourceId: string;
  conversationId: string | null;
  ownerEpoch: number | null;
  actor: CommerceActor;
  idempotencyKey: (operationId: string) => string;
  detail?: Record<string, unknown>;
}

/**
 * The operation ledger (C07). One row per external write, found again by its business key: a
 * retry reuses the row and its provider idempotency key, and the same key with other content is
 * refused. Rows are never deleted; every observation about them is a receipt.
 */
export async function openOperation(
  tx: TenantTx,
  id: string,
  input: NewOperation,
): Promise<OperationRow> {
  const [inserted] = await tx
    .insert(schema.operations)
    .values({
      id,
      tenantId: input.tenantId,
      kind: input.kind,
      businessKey: input.businessKey,
      requestHash: input.requestHash,
      provider: input.provider,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      conversationId: input.conversationId,
      ownerEpoch: input.ownerEpoch,
      actorType: input.actor.type,
      actorId: input.actor.id,
      providerIdempotencyKey: input.idempotencyKey(id),
      detail: input.detail ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(schema.operations)
    .where(eq(schema.operations.businessKey, input.businessKey))
    .for('update');
  if (!existing) throw new Error(`operation ${input.businessKey} vanished`);
  if (!existing.requestHash.equals(input.requestHash)) {
    throw new AppError('IDEMPOTENCY_CONFLICT', {
      detail: 'This action was already started with different details.',
    });
  }
  return existing;
}

export async function lockOperation(tx: TenantTx, id: string): Promise<OperationRow | null> {
  const [row] = await tx
    .select()
    .from(schema.operations)
    .where(eq(schema.operations.id, id))
    .for('update');
  return row ?? null;
}

/**
 * Moves an operation through its machine. Returns the updated row, or null when the move is not
 * allowed from where it is now (a late or repeated observation), in which case nothing changes.
 */
export async function moveOperation(
  tx: TenantTx,
  op: OperationRow,
  event: 'dispatch' | 'succeed' | 'fail' | 'lose_track' | 'cancel',
  set: Partial<{
    providerRef: string | null;
    lastErrorCode: string | null;
    nextReconcileAt: Date | null;
    dispatchedAt: Date;
    completedAt: Date;
    attempts: number;
    reconcileAttempts: number;
    detail: Record<string, unknown>;
  }>,
  now: Date,
): Promise<OperationRow | null> {
  const to = nextState(operationMachine, op.state as OperationState, event);
  if (to === null) return null;
  const final = to === 'succeeded' || to === 'failed' || to === 'cancelled';
  const [row] = await tx
    .update(schema.operations)
    .set({
      state: to,
      ...set,
      ...(final ? { nextReconcileAt: null, completedAt: set.completedAt ?? now } : {}),
      updatedAt: now,
    })
    .where(and(eq(schema.operations.id, op.id), eq(schema.operations.state, op.state)))
    .returning();
  return row ?? null;
}

export interface ReceiptInput {
  kind: ReceiptRow['kind'];
  outcome: ReceiptRow['outcome'];
  source: ReceiptRow['source'];
  providerRef?: string | null;
  providerEventId?: string | null;
  /** Non-sensitive facts only: provider status, amount, currency, error kind. */
  evidence?: Record<string, unknown>;
  observedAt: Date;
}

/** Appends a receipt (append-only table: the application role cannot change or delete it). */
export async function addReceipt(
  tx: TenantTx,
  op: Pick<OperationRow, 'id' | 'tenantId'>,
  input: ReceiptInput,
): Promise<ReceiptRow> {
  const [row] = await tx
    .insert(schema.operationReceipts)
    .values({
      tenantId: op.tenantId,
      operationId: op.id,
      kind: input.kind,
      outcome: input.outcome,
      source: input.source,
      providerRef: input.providerRef ?? null,
      providerEventId: input.providerEventId ?? null,
      evidence: input.evidence ?? {},
      observedAt: input.observedAt,
    })
    .returning();
  if (!row) throw new Error('receipt insert returned nothing');
  return row;
}

export async function receiptsOf(
  tx: TenantTx,
  operationIds: string[],
): Promise<Map<string, ReceiptRow[]>> {
  const found = new Map<string, ReceiptRow[]>();
  if (operationIds.length === 0) return found;
  const rows = await tx
    .select()
    .from(schema.operationReceipts)
    .where(inArray(schema.operationReceipts.operationId, operationIds))
    .orderBy(asc(schema.operationReceipts.observedAt), asc(schema.operationReceipts.createdAt));
  for (const row of rows) {
    found.set(row.operationId, [...(found.get(row.operationId) ?? []), row]);
  }
  return found;
}
