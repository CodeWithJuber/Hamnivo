import { schema, type TenantTx } from '@hamnivo/db';
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { JournalEntry, JournalService } from '../authority/journal.service.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;

/**
 * Read state in both directions (W05, W06). The customer's side is the last journal sequence the
 * widget displayed, which gives unread counts and tells Chatwoot the contact saw staff replies.
 * The staff side comes from the authority: the time staff last looked at the conversation, which
 * marks the customer's messages sent before it as read. Nothing is claimed read that the
 * authority did not report.
 */

/** Replies (anything not from the customer) after the customer's read point, per conversation. */
export async function unreadCounts(
  tx: TenantTx,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const j = schema.conversationJournal;
  const r = schema.conversationReadState;
  const rows = await tx
    .select({ conversationId: j.conversationId, count: sql<number>`count(*)::int` })
    .from(j)
    .leftJoin(r, eq(r.conversationId, j.conversationId))
    .where(
      and(
        inArray(j.conversationId, conversationIds),
        eq(j.lane, 'customer'),
        eq(j.eventType, 'message.created'),
        gt(j.seq, sql`coalesce(${r.customerReadSeq}, 0)`),
        sql`coalesce(${j.event}->'data'->'message'->'sender'->>'kind', '') <> 'customer'`,
      ),
    )
    .groupBy(j.conversationId);
  return new Map(rows.map((row) => [row.conversationId, Number(row.count)]));
}

/** The customer's read point moves forward only; it never passes the journal head. */
export async function advanceCustomerRead(
  tx: TenantTx,
  control: ControlRow,
  principalId: string,
  upToSequence: number,
  now: Date,
): Promise<{ advanced: boolean; syncedAt: Date | null }> {
  const upTo = Math.min(Math.max(0, Math.trunc(upToSequence)), control.journalSeq);
  const r = schema.conversationReadState;
  const [before] = await tx
    .select({ seq: r.customerReadSeq, syncedAt: r.customerSeenSyncedAt })
    .from(r)
    .where(eq(r.conversationId, control.id))
    .for('update');
  if (before && before.seq >= upTo) return { advanced: false, syncedAt: before.syncedAt };
  await tx
    .insert(r)
    .values({
      tenantId: control.tenantId,
      conversationId: control.id,
      principalId,
      customerReadSeq: upTo,
      customerReadAt: now,
    })
    .onConflictDoUpdate({
      target: [r.tenantId, r.conversationId],
      set: {
        customerReadSeq: sql`greatest(${r.customerReadSeq}, ${upTo})`,
        customerReadAt: now,
        updatedAt: now,
      },
    });
  return { advanced: upTo > 0, syncedAt: before?.syncedAt ?? null };
}

export async function markCustomerSeenSynced(
  tx: TenantTx,
  conversationId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.conversationReadState)
    .set({ customerSeenSyncedAt: now })
    .where(eq(schema.conversationReadState.conversationId, conversationId));
}

/** When the authority last reported staff saw the conversation (null when it never did). */
export async function staffSeenAt(tx: TenantTx, conversationId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ seenAt: schema.conversationReadState.agentSeenAt })
    .from(schema.conversationReadState)
    .where(eq(schema.conversationReadState.conversationId, conversationId));
  return row?.seenAt ?? null;
}

/**
 * Applies the time the authority says staff last saw the conversation: the newest customer
 * message created before it becomes read (one `delivery.updated`, which covers the earlier ones
 * too). A time that did not move, or that covers no new message, changes nothing.
 */
export async function applyStaffSeen(
  tx: TenantTx,
  journal: JournalService,
  tenantId: string,
  control: ControlRow,
  seenAt: Date | null | undefined,
  now: Date,
): Promise<JournalEntry[]> {
  if (!seenAt || !control.principalId) return [];
  const r = schema.conversationReadState;
  const [state] = await tx
    .select({ seenAt: r.agentSeenAt, messageId: r.agentReadMessageId })
    .from(r)
    .where(eq(r.conversationId, control.id))
    .for('update');
  if (state?.seenAt && state.seenAt.getTime() >= seenAt.getTime()) return [];
  const j = schema.conversationJournal;
  // Strictly before: the authority's times are in whole seconds, so a message from the same
  // second as the look may have arrived after it.
  const [newest] = await tx
    .select({ event: j.event })
    .from(j)
    .where(
      and(
        eq(j.conversationId, control.id),
        eq(j.lane, 'customer'),
        eq(j.eventType, 'message.created'),
        lt(j.authorityCreatedAt, seenAt),
        sql`${j.event}->'data'->'message'->'sender'->>'kind' = 'customer'`,
      ),
    )
    .orderBy(desc(j.seq))
    .limit(1);
  const messageId =
    (newest?.event as { data?: { message?: { id?: string } } } | undefined)?.data?.message?.id ??
    null;
  await tx
    .insert(r)
    .values({
      tenantId,
      conversationId: control.id,
      principalId: control.principalId,
      agentSeenAt: seenAt,
      agentReadMessageId: messageId,
    })
    .onConflictDoUpdate({
      target: [r.tenantId, r.conversationId],
      set: {
        agentSeenAt: seenAt,
        agentReadMessageId: messageId ?? sql`${r.agentReadMessageId}`,
        updatedAt: now,
      },
    });
  if (!messageId || messageId === state?.messageId) return [];
  return journal.append(tx, tenantId, control.id, [
    { lane: 'customer', type: 'delivery.updated', data: { messageId, state: 'read' } },
  ]);
}
