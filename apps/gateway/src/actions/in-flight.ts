import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';

/**
 * What changes for AI actions when someone else takes the conversation (G13, R07). Approvals are
 * bound to the ownership epoch, so an approval nobody gave yet, or one given but not yet sent, is
 * superseded: the new owner decides again. Anything already sent is never cancelled or resent: it
 * stays visible and keeps being reconciled, and the new owner is told about it.
 */
export async function supersedeForOwnerChange(
  tx: TenantTx,
  conversationId: string,
  newEpoch: number,
  now: Date,
): Promise<{ actionId: string; approver: 'customer' | 'staff' }[]> {
  const rows = await tx
    .update(schema.actions)
    .set({ state: 'superseded', reason: 'owner_changed', updatedAt: now })
    .where(
      and(
        eq(schema.actions.conversationId, conversationId),
        inArray(schema.actions.state, ['awaiting_approval', 'approved']),
        lt(schema.actions.ownerEpoch, newEpoch),
      ),
    )
    .returning({
      id: schema.actions.id,
      approver: schema.actions.approver,
      tool: schema.actions.toolName,
    });
  for (const row of rows) {
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'ownership',
      action: 'ai.action.superseded',
      targetType: 'action',
      targetId: toPublicId('action', row.id),
      outcome: 'success',
      occurredAt: now,
      data: { tool: row.tool, reason: 'owner_changed', epoch: newEpoch },
    });
  }
  return rows.map((row) => ({ actionId: toPublicId('action', row.id), approver: row.approver }));
}

const WAITING: Record<string, string> = {
  executing: 'sent, waiting for the result',
  unknown: 'sent, but the result is not confirmed yet; Hamnivo is checking',
};

/**
 * Actions the AI already sent whose outcome is still open, for whoever takes over, or null when
 * there are none. Hamnivo keeps checking them and posts the result in the conversation.
 */
export async function actionsInFlightNote(
  tx: TenantTx,
  conversationId: string,
): Promise<string | null> {
  const open = await tx
    .select()
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.conversationId, conversationId),
        inArray(schema.actions.state, ['executing', 'unknown']),
      ),
    )
    .orderBy(asc(schema.actions.createdAt));
  if (open.length === 0) return null;
  return [
    'AI actions in progress in this conversation:',
    ...open.map((a) => `- ${a.summary}: ${WAITING[a.state] ?? a.state}.`),
    'Do not do them again by hand. Hamnivo keeps checking and posts the result here.',
  ].join('\n');
}
