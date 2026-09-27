import { schema, type TenantTx } from '@hamnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { moneyText } from './common.js';

type OperationRow = typeof schema.operations.$inferSelect;

const WAITING: Record<string, string> = {
  pending: 'about to be sent',
  dispatched: 'sent, waiting for the answer',
  unknown: 'outcome not known yet, being checked with the provider',
};

async function describe(tx: TenantTx, op: OperationRow): Promise<string> {
  if (op.kind === 'commerce.checkout.create' && op.resourceId) {
    const [order] = await tx
      .select({
        reference: schema.orders.reference,
        total: schema.orders.totalMinor,
        currency: schema.orders.currency,
      })
      .from(schema.orders)
      .where(eq(schema.orders.purchaseIntentId, op.resourceId));
    if (order) {
      return `Payment for order ${order.reference}, ${moneyText(order.total, order.currency)}`;
    }
    const [quote] = await tx
      .select({ total: schema.quotes.totalMinor, currency: schema.quotes.currency })
      .from(schema.purchaseIntents)
      .innerJoin(schema.quotes, eq(schema.quotes.id, schema.purchaseIntents.quoteId))
      .where(eq(schema.purchaseIntents.id, op.resourceId));
    return quote
      ? `Payment page for a new order, ${moneyText(quote.total, quote.currency)}`
      : 'Payment page for a new order';
  }
  if (op.kind === 'commerce.refund.create' && op.resourceId) {
    const [refund] = await tx
      .select({
        amount: schema.refunds.amountMinor,
        currency: schema.refunds.currency,
        reference: schema.orders.reference,
      })
      .from(schema.refunds)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.refunds.orderId))
      .where(eq(schema.refunds.id, op.resourceId));
    if (refund) {
      return `Refund of ${moneyText(refund.amount, refund.currency)} for order ${refund.reference}`;
    }
  }
  return op.kind;
}

/**
 * What a person taking over needs to know about money in flight (R07): every payment or refund
 * in this conversation still owed an outcome, in plain words, or null when there is none. The
 * worker keeps reconciling them whoever owns the conversation, and posts the outcome here.
 */
export async function inFlightNote(tx: TenantTx, conversationId: string): Promise<string | null> {
  const open = await tx
    .select()
    .from(schema.operations)
    .where(
      and(
        eq(schema.operations.conversationId, conversationId),
        inArray(schema.operations.state, ['pending', 'dispatched', 'unknown']),
      ),
    )
    .orderBy(asc(schema.operations.createdAt));
  if (open.length === 0) return null;
  const lines: string[] = [];
  for (const op of open) {
    lines.push(`- ${await describe(tx, op)}: ${WAITING[op.state] ?? op.state}.`);
  }
  return [
    'Money in progress in this conversation:',
    ...lines,
    'Do not take the payment or make the refund again. Hamnivo keeps checking and posts the outcome here.',
  ].join('\n');
}
