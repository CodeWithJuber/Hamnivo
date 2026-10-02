import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import type { ExceptionRow } from './views.js';

export interface ExceptionInput {
  tenantId: string;
  kind: ExceptionRow['kind'];
  subjectType: ExceptionRow['subjectType'];
  subjectId: string;
  operationId?: string | null;
  orderId?: string | null;
  /** The provider-side state last observed, in the provider's words. */
  sourceState: string;
  nextSafeAction: ExceptionRow['nextSafeAction'];
  evidence: Record<string, unknown>;
  now: Date;
}

/**
 * Opens a finance exception (C19), or refreshes the open one for the same kind and subject.
 * Opening is audited; nothing here moves money.
 */
export async function openException(tx: TenantTx, input: ExceptionInput): Promise<ExceptionRow> {
  const [row] = await tx
    .insert(schema.financeExceptions)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      operationId: input.operationId ?? null,
      orderId: input.orderId ?? null,
      sourceState: input.sourceState,
      nextSafeAction: input.nextSafeAction,
      evidence: input.evidence,
      openedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        schema.financeExceptions.tenantId,
        schema.financeExceptions.kind,
        schema.financeExceptions.subjectId,
      ],
      targetWhere: sql`${schema.financeExceptions.state} = 'open'`,
      set: {
        sourceState: input.sourceState,
        nextSafeAction: input.nextSafeAction,
        evidence: input.evidence,
        updatedAt: input.now,
      },
    })
    .returning();
  if (!row) throw new Error('finance exception upsert returned nothing');
  if (row.createdAt.getTime() === row.updatedAt.getTime()) {
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.exception.opened',
      targetType: 'finance_exception',
      targetId: toPublicId('financeException', row.id),
      outcome: 'success',
      occurredAt: input.now,
      data: { kind: row.kind, subjectType: row.subjectType, sourceState: row.sourceState },
    });
  }
  return row;
}

/** Closes open exceptions about a subject once the provider has given a final answer. */
export async function resolveExceptionsFor(
  tx: TenantTx,
  subjectId: string,
  now: Date,
  kinds?: ExceptionRow['kind'][],
): Promise<void> {
  const open = await tx
    .select()
    .from(schema.financeExceptions)
    .where(
      and(
        eq(schema.financeExceptions.subjectId, subjectId),
        eq(schema.financeExceptions.state, 'open'),
      ),
    );
  for (const row of open) {
    if (kinds && !kinds.includes(row.kind)) continue;
    await tx
      .update(schema.financeExceptions)
      .set({
        state: 'resolved',
        resolvedAt: now,
        resolution: 'provider_confirmed',
        resolutionNote: 'The provider confirmed the outcome.',
        updatedAt: now,
      })
      .where(eq(schema.financeExceptions.id, row.id));
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.exception.resolved',
      targetType: 'finance_exception',
      targetId: toPublicId('financeException', row.id),
      outcome: 'success',
      occurredAt: now,
      data: { kind: row.kind, resolution: 'provider_confirmed' },
    });
  }
}
