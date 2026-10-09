import type { CustomerConversation, MessagePart } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { customerView } from '../authority/views.js';
import { customerTicket } from '../tickets/tickets.js';
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

/** Ticket numbers and snooze times of these conversations (H19). */
export async function ticketFacts(
  tx: TenantTx,
  conversationIds: string[],
): Promise<Map<string, { number: number | null; snoozedUntil: Date | null }>> {
  if (conversationIds.length === 0) return new Map();
  const s = schema.conversationInboxState;
  const rows = await tx
    .select({ id: s.conversationId, number: s.ticketNumber, snoozedUntil: s.snoozedUntil })
    .from(s)
    .where(inArray(s.conversationId, conversationIds));
  return new Map(rows.map((r) => [r.id, { number: r.number, snoozedUntil: r.snoozedUntil }]));
}

export function customerConversation(
  row: ControlRow,
  preview: string | null,
  unreadCount = 0,
  facts: { number: number | null; snoozedUntil: Date | null } = {
    number: null,
    snoozedUntil: null,
  },
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
    ticket: customerTicket(facts.number, row.authorityStatus, facts.snoozedUntil),
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
  const ids = rows.map((row) => row.id);
  const unread = await unreadCounts(tx, ids);
  const tickets = await ticketFacts(tx, ids);
  const items: CustomerConversation[] = [];
  for (const row of rows) {
    items.push(
      customerConversation(
        row,
        await lastPreview(tx, row.id),
        unread.get(row.id) ?? 0,
        tickets.get(row.id),
      ),
    );
  }
  return items;
}
