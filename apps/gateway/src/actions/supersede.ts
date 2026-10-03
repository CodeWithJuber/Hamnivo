import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, inArray } from 'drizzle-orm';
import type { JournalService } from '../authority/journal.service.js';
import type { Effects } from '../commerce/effects.js';

/**
 * Supersedes what still waits on these tools (a request for approval, or an approved one that has
 * not been sent), because the tool changed or went away, and tells the conversations it was in.
 * Returns how many requests it ended.
 */
export async function supersedePending(
  tx: TenantTx,
  journal: JournalService,
  effects: Effects,
  tenantId: string,
  toolIds: string[],
  now: Date,
): Promise<number> {
  if (toolIds.length === 0) return 0;
  const pending = await tx
    .update(schema.actions)
    .set({ state: 'superseded', reason: 'tool_changed', updatedAt: now })
    .where(
      and(
        inArray(schema.actions.toolId, toolIds),
        inArray(schema.actions.state, ['awaiting_approval', 'approved']),
      ),
    )
    .returning();
  for (const action of pending) {
    effects.add(
      tenantId,
      action.conversationId,
      await journal.append(tx, tenantId, action.conversationId, [
        {
          lane: action.approver === 'customer' ? 'customer' : 'staff',
          type: 'approval.updated',
          data: { approvalId: toPublicId('action', action.id), status: 'superseded' },
        },
      ]),
    );
  }
  return pending.length;
}
