import type { TenantTx } from '@hamnivo/db';
import type { JournalEntry, JournalService } from '../authority/journal.service.js';

/**
 * What a commerce transaction wants done after it commits: wake the conversation's live
 * streams. Card posts need nothing here: they are relayed by the outbox written in the same
 * transaction.
 */
export class Effects {
  private readonly journal: {
    tenantId: string;
    conversationId: string;
    entries: JournalEntry[];
  }[] = [];

  add(tenantId: string, conversationId: string, entries: JournalEntry[]): void {
    if (entries.length) this.journal.push({ tenantId, conversationId, entries });
  }

  async flush(journal: JournalService): Promise<void> {
    for (const item of this.journal.splice(0)) {
      await journal.notify(item.tenantId, item.conversationId, item.entries);
    }
  }
}

export type ActionOutcome =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/** Journals a customer-visible `action.updated` event for a purchase or refund. */
export async function journalAction(
  journal: JournalService,
  tx: TenantTx,
  effects: Effects,
  input: {
    tenantId: string;
    conversationId: string;
    actionId: string;
    outcome: ActionOutcome;
    summary: string;
  },
): Promise<void> {
  const entries = await journal.append(tx, input.tenantId, input.conversationId, [
    {
      lane: 'customer',
      type: 'action.updated',
      data: {
        actionId: input.actionId,
        outcome: input.outcome,
        summary: input.summary.slice(0, 300),
      },
    },
  ]);
  effects.add(input.tenantId, input.conversationId, entries);
}
