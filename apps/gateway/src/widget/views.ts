import type { CustomerConversation } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, desc, eq } from 'drizzle-orm';
import { customerView } from '../authority/views.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;

/** Latest customer-visible message text for list previews (from the journal, max 200 chars). */
export async function lastPreview(tx: TenantTx, conversationId: string): Promise<string | null> {
  const j = schema.conversationJournal;
  const [row] = await tx
    .select({ event: j.event })
    .from(j)
    .where(
      and(
        eq(j.conversationId, conversationId),
        eq(j.lane, 'customer'),
        eq(j.eventType, 'message.created'),
      ),
    )
    .orderBy(desc(j.seq))
    .limit(1);
  const message = (
    row?.event as { data?: { message?: { parts?: { type: string; text?: string }[] } } } | undefined
  )?.data?.message;
  const text = message?.parts?.find((p) => p.type === 'text')?.text;
  return text ? text.slice(0, 200) : null;
}

export function customerConversation(
  row: ControlRow,
  preview: string | null,
): CustomerConversation {
  const view = customerView(row.ownerMode, row.authorityStatus);
  return {
    id: toPublicId('conversation', row.id),
    status: view.status,
    responder: view.responder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.lastActivityAt.toISOString(),
    unreadCount: 0,
    lastMessagePreview: preview,
    latestSequence: row.journalSeq,
  };
}

/** The principal's conversations, newest activity first. */
export async function principalConversations(
  tx: TenantTx,
  principalId: string,
  limit = 20,
): Promise<CustomerConversation[]> {
  const c = schema.conversationControls;
  const rows = await tx
    .select()
    .from(c)
    .where(eq(c.principalId, principalId))
    .orderBy(desc(c.lastActivityAt))
    .limit(limit);
  const items: CustomerConversation[] = [];
  for (const row of rows) items.push(customerConversation(row, await lastPreview(tx, row.id)));
  return items;
}
