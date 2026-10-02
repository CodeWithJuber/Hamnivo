import { schema, type TenantTx } from '@hamnivo/db';
import type { ClaimEvidence } from '@hamnivo/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { receiptEvidence } from '../commerce/claims.js';

/** Refund states after Hamnivo sent the refund to the provider: it is committed to it. */
const COMMITTED_REFUND_STATES = ['submitted', 'pending', 'succeeded'] as const;

/** Action states after the approval: the change is Hamnivo's to make, or already sent. */
const COMMITTED_ACTION_STATES = ['approved', 'executing', 'unknown'] as const;

/**
 * Changes AI actions made in the conversation (G13). Their receipts are in the operation ledger
 * with the payments' and refunds' (`subject: tool`), and the tool gateway's own claim check
 * (`ToolGateway.evidence`) reads them the same way: a completed action that is not a lookup, with
 * a succeeded receipt. An action approved or sent but not settled is a commitment.
 */
async function orderChangeEvidence(
  tx: TenantTx,
  conversationId: string,
): Promise<ClaimEvidence['orderChange']> {
  const a = schema.actions;
  const r = schema.operationReceipts;
  const rows = await tx
    .select({
      state: a.state,
      receipted: sql<boolean>`exists (select 1 from ${r} where ${r.operationId} = ${a.operationId} and ${r.outcome} = 'succeeded')`,
    })
    .from(a)
    .where(and(eq(a.conversationId, conversationId), ne(a.risk, 'read')));
  if (rows.some((row) => row.state === 'completed' && row.receipted)) return 'confirmed';
  if (rows.some((row) => (COMMITTED_ACTION_STATES as readonly string[]).includes(row.state))) {
    return 'committed';
  }
  return undefined;
}

/**
 * What Hamnivo's records show for a conversation's payments, refunds and AI actions, never its
 * text: the provider receipts the receipt check reads (X10), whether a refund was submitted, and
 * the receipts of changes AI actions made.
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
  const orderChange = await orderChangeEvidence(tx, conversationId);
  return {
    ...receipts,
    refundCommitted: Boolean(committed),
    ...(orderChange ? { orderChange } : {}),
  };
}
