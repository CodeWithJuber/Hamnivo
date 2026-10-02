import { schema, type TenantTx } from '@hamnivo/db';
import {
  type ClaimVerdict,
  checkCompletionClaims,
  findCompletionClaims,
} from '@hamnivo/domain/commerce';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Receipt-based completion (X10): an AI reply may say a payment or refund is done only when a
 * provider receipt in this conversation shows it. The evidence is read from Hamnivo's records,
 * never from the conversation text.
 */
export async function receiptEvidence(
  tx: TenantTx,
  conversationId: string,
): Promise<{ paymentConfirmed: boolean; refundConfirmed: boolean }> {
  const [paid] = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .innerJoin(
      schema.purchaseIntents,
      eq(schema.purchaseIntents.id, schema.payments.purchaseIntentId),
    )
    .innerJoin(
      schema.operationReceipts,
      eq(schema.operationReceipts.operationId, schema.purchaseIntents.checkoutOperationId),
    )
    .where(
      and(
        eq(schema.purchaseIntents.conversationId, conversationId),
        eq(schema.payments.state, 'captured'),
        eq(schema.operationReceipts.outcome, 'succeeded'),
        sql`${schema.operationReceipts.evidence} ->> 'subject' = 'payment'`,
      ),
    )
    .limit(1);
  const [refunded] = await tx
    .select({ id: schema.refunds.id })
    .from(schema.refunds)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.refunds.orderId))
    .innerJoin(
      schema.operationReceipts,
      eq(schema.operationReceipts.operationId, schema.refunds.operationId),
    )
    .where(
      and(
        eq(schema.orders.conversationId, conversationId),
        eq(schema.refunds.state, 'succeeded'),
        eq(schema.operationReceipts.outcome, 'succeeded'),
        sql`${schema.operationReceipts.evidence} ->> 'subject' = 'refund'`,
      ),
    )
    .limit(1);
  return { paymentConfirmed: Boolean(paid), refundConfirmed: Boolean(refunded) };
}

/**
 * Checks a draft reply; the receipts are only read when the text claims a completion.
 * `claimed` lists what the text claims, for the run record.
 */
export async function checkReplyClaims(
  tx: TenantTx,
  conversationId: string,
  text: string,
): Promise<{ verdict: ClaimVerdict; claimed: string[] }> {
  const found = findCompletionClaims(text);
  if (found.length === 0) return { verdict: { ok: true }, claimed: [] };
  return {
    verdict: checkCompletionClaims(text, await receiptEvidence(tx, conversationId)),
    claimed: [...new Set(found.map((f) => f.claim))],
  };
}

export const CLAIM_CORRECTION =
  'Your previous draft said a payment or refund is complete, but there is no receipt for that. ' +
  'Do not say it is paid, charged or refunded. Say it is not confirmed yet, and that the order ' +
  'card in the chat shows the confirmed status.';
