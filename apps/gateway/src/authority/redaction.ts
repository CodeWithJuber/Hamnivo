import { schema, type TenantTx } from '@hamnivo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { DELETED_PART } from './extended-parts.js';
import type { JournalEntry, JournalService, Lane } from './journal.service.js';

/**
 * A message deleted in the authority (W23), whoever deleted it: the journal's stored copies lose
 * their text and files, so a replay or a list preview cannot bring them back, and the lane gets
 * one `message.redacted` event, however many paths (API, webhook, reconciler) report it.
 */
export async function redactJournaledMessage(
  tx: TenantTx,
  journal: JournalService,
  input: {
    tenantId: string;
    conversationId: string;
    lane: Lane;
    authorityId: number;
    messageId: string;
  },
): Promise<JournalEntry[]> {
  const j = schema.conversationJournal;
  const stored = await tx
    .select({ lane: j.lane, seq: j.seq, event: j.event })
    .from(j)
    .where(
      and(
        eq(j.conversationId, input.conversationId),
        eq(j.authorityId, input.authorityId),
        inArray(j.eventType, ['message.created', 'message.updated']),
      ),
    );
  for (const row of stored) {
    const event = row.event as { data?: { message?: { parts?: unknown[] } } };
    const message = event.data?.message;
    if (!message) continue;
    await tx
      .update(j)
      .set({
        event: {
          ...event,
          data: { ...event.data, message: { ...message, parts: [DELETED_PART] } },
        },
      })
      .where(
        and(eq(j.conversationId, input.conversationId), eq(j.lane, row.lane), eq(j.seq, row.seq)),
      );
  }
  const [already] = await tx
    .select({ seq: j.seq })
    .from(j)
    .where(
      and(
        eq(j.conversationId, input.conversationId),
        eq(j.lane, input.lane),
        eq(j.authorityId, input.authorityId),
        eq(j.eventType, 'message.redacted'),
      ),
    )
    .limit(1);
  if (already) return [];
  return journal.append(tx, input.tenantId, input.conversationId, [
    {
      lane: input.lane,
      type: 'message.redacted',
      data: { messageId: input.messageId, reason: 'deleted' },
      authorityId: input.authorityId,
    },
  ]);
}
