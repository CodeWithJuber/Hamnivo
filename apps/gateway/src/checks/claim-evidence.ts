import { schema, type TenantTx } from '@hamnivo/db';
import type { ClaimEvidence } from '@hamnivo/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { receiptEvidence } from '../commerce/claims.js';

/** Refund states after Hamnivo sent the refund to the provider: it is committed to it. */
const COMMITTED_REFUND_STATES = ['submitted', 'pending', 'succeeded'] as const;

/**
 * What Hamnivo's records show for a conversation's payments and refunds, never its text: the
 * provider receipts the receipt check reads (X10), and whether a refund was submitted.
 */
export async function claimEvidence(tx: TenantTx, conversationId: string): Promise<ClaimEvidence> {
  const receipts = await receiptEvidence(tx, conversationId);
  const [committed] = await tx
    .select({ id: schema.refunds.id })
    .from(schema.refunds)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.refunds.orderId))
    .where(
      and(
        eq(schema.orders.conversationId, conversationId),
        inArray(schema.refunds.state, [...COMMITTED_REFUND_STATES]),
      ),
    )
    .limit(1);
  return { ...receipts, refundCommitted: Boolean(committed) };
}
