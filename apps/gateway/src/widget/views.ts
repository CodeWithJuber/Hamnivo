import type { CustomerConversation, MessagePart } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, desc, eq } from 'drizzle-orm';
import { customerView } from '../authority/views.js';
import { unreadCounts } from './read-state.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;

/** One line for a list preview: the text, else what was shared (a file, a place, a reaction). */
export function previewOf(parts: readonly MessagePart[]): string | null {
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) return part.text;
  }
  for (const part of parts) {
    switch (part.type) {
      case 'attachment':
        return `📎 ${part.name}`;
      case 'location':
        return `📍 ${part.label ?? `${part.latitude.toFixed(4)}, ${part.longitude.toFixed(4)}`}`;
      case 'contact':
        return `👤 ${part.name}`;
      case 'reaction':
        return part.emoji;
      case 'notice':
      case 'card':
        return part.type === 'card' ? part.fallbackText : part.text;
      default:
        break;
    }
  }
  return null;
}

/** Latest customer-visible message for list previews (from the journal, max 200 chars). */
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
  const message = (row?.event as { data?: { message?: { parts?: MessagePart[] } } } | undefined)
    ?.data?.message;
  const text = previewOf(message?.parts ?? []);
  return text ? text.slice(0, 200) : null;
}

export function customerConversation(
  row: ControlRow,
  preview: string | null,
  unreadCount = 0,
): CustomerConversation {
  const view = customerView(row.ownerMode, row.authorityStatus);
  return {
    id: toPublicId('conversation', row.id),
    status: view.status,
    responder: view.responder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.lastActivityAt.toISOString(),
    unreadCount,
    lastMessagePreview: preview,
    latestSequence: row.journalSeq,
  };
}

/**
 * The principal's conversations, newest activity first, with replies they have not seen yet. A
 * verified customer is one principal on every device, so another device lists the same chats
 * (W18); an anonymous visitor's principal lives only in its own browser.
 */
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
  const unread = await unreadCounts(
    tx,
    rows.map((row) => row.id),
  );
  const items: CustomerConversation[] = [];
  for (const row of rows) {
    items.push(customerConversation(row, await lastPreview(tx, row.id), unread.get(row.id) ?? 0));
  }
  return items;
}
