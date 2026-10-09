import { schema, type TenantTx } from '@hamnivo/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;

/** Outbox topics for customer emails (W25); the worker sends them. */
export const TRANSCRIPT_TOPIC = 'customer.transcript';
export const REPLY_WAITING_TOPIC = 'customer.reply_waiting';

async function wants(
  tx: TenantTx,
  principalId: string,
  kind: 'transcript' | 'replyWaiting',
): Promise<boolean> {
  const [prefs] = await tx
    .select()
    .from(schema.customerNotificationPreferences)
    .where(eq(schema.customerNotificationPreferences.principalId, principalId));
  return prefs?.[kind] === true;
}

/**
 * Queues a transcript when a conversation is closed and its customer asked for transcripts. The
 * worker checks again before sending: a choice changed in the meantime wins.
 */
export async function queueTranscript(
  tx: TenantTx,
  tenantId: string,
  control: ControlRow,
  resolvedSeq: number,
): Promise<void> {
  if (!control.principalId || !(await wants(tx, control.principalId, 'transcript'))) return;
  await enqueueOutbox(tx, tenantId, {
    topic: TRANSCRIPT_TOPIC,
    aggregateType: 'conversation',
    aggregateId: control.id,
    payload: { conversationId: control.id, seq: resolvedSeq },
  });
}

/** A ticket from the contact form whose address the customer confirmed (W11, H19). */
async function confirmedTicket(tx: TenantTx, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.ticketFollowups.id })
    .from(schema.ticketFollowups)
    .where(
      and(
        eq(schema.ticketFollowups.conversationId, conversationId),
        isNotNull(schema.ticketFollowups.confirmedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Queues a "a reply is waiting" check for a reply from staff or the assistant, due after a delay:
 * for customers who asked for these emails, and for tickets whose address was confirmed (their
 * email carries the answer). If the customer read it in the meantime, nothing is sent.
 */
export async function queueReplyWaiting(
  tx: TenantTx,
  tenantId: string,
  control: ControlRow,
  authorityId: number,
  dueAt: Date,
): Promise<void> {
  if (!control.principalId) return;
  const queued =
    (await wants(tx, control.principalId, 'replyWaiting')) ||
    (await confirmedTicket(tx, control.id));
  if (!queued) return;
  await tx.insert(schema.outboxEvents).values({
    tenantId,
    topic: REPLY_WAITING_TOPIC,
    aggregateType: 'conversation',
    aggregateId: control.id,
    payload: { conversationId: control.id, authorityId },
    availableAt: dueAt,
  });
}
