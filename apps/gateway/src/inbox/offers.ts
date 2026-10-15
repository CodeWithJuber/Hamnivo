import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';

/** Outbox topic: an offer's time is up; the next person is offered the conversation. */
export const OFFER_TIMEOUT_TOPIC = 'conversation.offer_timeout';
/** Outbox topic: offer the conversation to the next person now (after a decline or going away). */
export const OFFER_NEXT_TOPIC = 'conversation.offer_next';

type OfferRow = typeof schema.conversationOffers.$inferSelect;
type CancelReason = NonNullable<OfferRow['cancelReason']>;

const waitingModes = new Set(['WAITING_HUMAN', 'PAUSED']);

/** Ends a pending offer that can no longer be accepted, with why, in the audit log too. */
export async function cancelOffer(
  tx: TenantTx,
  offer: OfferRow,
  reason: CancelReason,
  now: Date,
): Promise<void> {
  const [ended] = await tx
    .update(schema.conversationOffers)
    .set({ state: 'cancelled', cancelReason: reason, decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.conversationOffers.id, offer.id),
        eq(schema.conversationOffers.state, 'pending'),
      ),
    )
    .returning({ id: schema.conversationOffers.id });
  if (!ended) return;
  await appendAudit(tx, {
    actorType: 'system',
    actorId: 'offers',
    action: 'conversation.offer_cancelled',
    targetType: 'conversation',
    targetId: toPublicId('conversation', offer.conversationId),
    outcome: 'success',
    data: {
      offer: toPublicId('offer', offer.id),
      staffMemberId: toPublicId('staff', offer.staffMemberId),
      reason,
    },
  });
}

/**
 * Ends the conversation's pending offer when it can no longer be accepted (HNV-10-03): someone
 * now has the conversation, or it was resolved, snoozed or given to another team. Call it under
 * the control row's lock, after the change. A team change offers the next person in the new team.
 */
export async function settleOffer(tx: TenantTx, conversationId: string, now: Date): Promise<void> {
  const [offer] = await tx
    .select()
    .from(schema.conversationOffers)
    .where(
      and(
        eq(schema.conversationOffers.conversationId, conversationId),
        eq(schema.conversationOffers.state, 'pending'),
      ),
    );
  if (!offer) return;
  const [control] = await tx
    .select({
      ownerMode: schema.conversationControls.ownerMode,
      ownershipEpoch: schema.conversationControls.ownershipEpoch,
      authorityStatus: schema.conversationControls.authorityStatus,
    })
    .from(schema.conversationControls)
    .where(eq(schema.conversationControls.id, conversationId));
  const [state] = await tx
    .select({ teamId: schema.conversationInboxState.teamId })
    .from(schema.conversationInboxState)
    .where(eq(schema.conversationInboxState.conversationId, conversationId));
  let reason: CancelReason | null = null;
  if (!control || !waitingModes.has(control.ownerMode)) reason = 'owner_changed';
  else if (control.ownershipEpoch !== offer.handoffEpoch) reason = 'owner_changed';
  else if (control.authorityStatus === 'resolved') reason = 'resolved';
  else if (control.authorityStatus === 'snoozed') reason = 'snoozed';
  else if ((state?.teamId ?? null) !== offer.teamId) reason = 'team_changed';
  if (!reason) return;
  // A new team offers the conversation to its own people after `conversation.team_changed`.
  await cancelOffer(tx, offer, reason, now);
}

/** Asks the worker to offer the conversation to the next person (or end the offers). */
export async function queueOfferNext(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  why: string,
): Promise<void> {
  await enqueueOutbox(tx, tenantId, {
    topic: OFFER_NEXT_TOPIC,
    aggregateType: 'conversation',
    aggregateId: conversationId,
    payload: { conversationId, why },
  });
}
