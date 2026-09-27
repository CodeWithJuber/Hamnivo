import type {
  CartView,
  CustomerOrderView,
  FinanceExceptionView,
  FulfillmentView,
  MerchantConnection,
  OperationView,
  OrderSummary,
  PurchaseIntentView,
  QuoteDocument,
  QuoteView,
  ReceiptView,
  RefundView,
} from '@hamnivo/contracts';
import { schema, toPublicId } from '@hamnivo/db';
import type { z } from 'zod';
import { iso } from '../common/views.js';
import { quoteCard } from './cards.js';
import { minor } from './common.js';
import type { OperationRow, ReceiptRow } from './ledger.js';
import type { MerchantRow } from './providers.service.js';

export type CartRow = typeof schema.carts.$inferSelect;
export type QuoteRow = typeof schema.quotes.$inferSelect;
export type IntentRow = typeof schema.purchaseIntents.$inferSelect;
export type PaymentRow = typeof schema.payments.$inferSelect;
export type OrderRow = typeof schema.orders.$inferSelect;
export type RefundRow = typeof schema.refunds.$inferSelect;
export type FulfillmentRow = typeof schema.fulfillments.$inferSelect;
export type ExceptionRow = typeof schema.financeExceptions.$inferSelect;

type QuoteDoc = z.infer<typeof QuoteDocument>;
type Fulfillment = z.infer<typeof FulfillmentView>;

export interface OrderLine {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: string;
  totalMinor: string;
}

export function merchantView(
  row: MerchantRow,
  hints: { apiKey: string | null; webhookSecret: string | null },
  publicApiOrigin: string,
): MerchantConnection {
  const config = row.config;
  const id = toPublicId('merchant', row.id);
  return {
    id,
    brandId: toPublicId('brand', row.brandId),
    provider: row.provider === 'stripe' ? 'stripe' : 'mock',
    displayName: row.displayName,
    status: row.status,
    providerAccountId: row.providerAccountId,
    currencies: config.currencies,
    shipping: config.shipping ?? null,
    capabilities: row.capabilities as MerchantConnection['capabilities'],
    refundPolicy: config.refundPolicy,
    terms: {
      refundSummary: config.terms?.refundSummary ?? null,
      termsUrl: config.terms?.termsUrl ?? null,
    },
    quoteMinutes: config.quoteMinutes ?? 15,
    webhookUrl: `${publicApiOrigin.replace(/\/$/, '')}/v1/integrations/commerce/${id}/webhook`,
    credentials: {
      apiKey: hints.apiKey === null ? null : `••••${hints.apiKey}`,
      webhookSecret: hints.webhookSecret === null ? null : `••••${hints.webhookSecret}`,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function cartView(
  cart: CartRow,
  merchant: Pick<MerchantRow, 'id' | 'displayName'>,
): z.infer<typeof CartView> {
  const priced = cart.lines.every((l) => typeof l.unitPriceMinor === 'string');
  const estimate = priced
    ? cart.lines.reduce(
        (acc, l) => acc + BigInt(l.unitPriceMinor as string) * BigInt(l.quantity),
        0n,
      )
    : null;
  return {
    id: toPublicId('cart', cart.id),
    revision: cart.revision,
    status: cart.status,
    merchant: { id: toPublicId('merchant', merchant.id), name: merchant.displayName },
    currency: cart.currency,
    lines: cart.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      name: l.name ?? null,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor ?? null,
    })),
    itemCount: cart.lines.reduce((acc, l) => acc + l.quantity, 0),
    estimatedSubtotalMinor: estimate === null || cart.lines.length === 0 ? null : minor(estimate),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/** A quote reads as expired once its time has passed, even before anything is written. */
export function quoteStatus(quote: QuoteRow, now: Date): QuoteView['status'] {
  if (quote.status === 'ready' && now.getTime() >= quote.expiresAt.getTime()) return 'expired';
  return quote.status;
}

/** What the customer is told about a purchase: "paid" only with the provider's receipt. */
export function purchaseOutcome(
  intent: IntentRow,
  payment: PaymentRow | null,
): PurchaseIntentView['outcome'] {
  switch (intent.state) {
    case 'draft':
    case 'quoted':
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'approved':
    case 'unknown':
      return 'preparing_checkout';
    case 'executing':
      if (!payment) return 'preparing_checkout';
      return payment.state === 'not_started' || payment.state === 'requires_action'
        ? 'awaiting_payment'
        : 'confirming';
    case 'completed':
      return 'paid';
    case 'failed':
    case 'denied':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'needs_human':
      return 'needs_human';
  }
}

export function intentView(
  intent: IntentRow,
  payment: PaymentRow | null,
  order: OrderRow | null,
  now: Date,
): PurchaseIntentView {
  const outcome = purchaseOutcome(intent, payment);
  const open =
    outcome === 'awaiting_payment' &&
    intent.checkoutUrl !== null &&
    (intent.checkoutExpiresAt === null || intent.checkoutExpiresAt.getTime() > now.getTime());
  return {
    id: toPublicId('purchase', intent.id),
    quoteId: toPublicId('quote', intent.quoteId),
    state: intent.state,
    outcome,
    checkout: intent.checkoutSessionRef
      ? {
          url: open ? intent.checkoutUrl : null,
          expiresAt: iso(intent.checkoutExpiresAt),
        }
      : null,
    order: order ? { id: toPublicId('order', order.id), reference: order.reference } : null,
    payment: payment
      ? {
          state: payment.state,
          amountMinor: minor(payment.amountMinor),
          currency: payment.currency,
          confirmedAt: iso(payment.capturedAt),
        }
      : null,
    updatedAt: intent.updatedAt.toISOString(),
  };
}

export function quoteView(input: {
  quote: QuoteRow;
  intent: IntentRow | null;
  payment: PaymentRow | null;
  order: OrderRow | null;
  merchant: MerchantRow;
  now: Date;
}): QuoteView {
  const { quote, merchant } = input;
  const document = quote.document as unknown as QuoteDoc;
  const hash = quote.hash.toString('hex');
  return {
    id: toPublicId('quote', quote.id),
    status: quoteStatus(quote, input.now),
    approver: quote.approver,
    hash,
    document,
    card: quoteCard(document, hash, toPublicId('merchant', merchant.id)),
    transparency: {
      seller: merchant.displayName,
      paymentPage: 'provider_hosted',
      recurring: document.recurring !== null,
      refundSummary: merchant.config.terms?.refundSummary ?? null,
      termsUrl: merchant.config.terms?.termsUrl ?? null,
    },
    expiresAt: quote.expiresAt.toISOString(),
    intent: input.intent ? intentView(input.intent, input.payment, input.order, input.now) : null,
  };
}

export function receiptView(row: ReceiptRow): z.infer<typeof ReceiptView> {
  return {
    id: toPublicId('receipt', row.id),
    kind: row.kind,
    outcome: row.outcome,
    source: row.source,
    providerRef: row.providerRef,
    providerEventId: row.providerEventId,
    observedAt: row.observedAt.toISOString(),
  };
}

export function operationView(
  op: OperationRow,
  receipts: ReceiptRow[],
): z.infer<typeof OperationView> {
  return {
    id: toPublicId('operation', op.id),
    kind: op.kind,
    state: op.state,
    provider: op.provider,
    providerRef: op.providerRef,
    actor: op.actorType,
    attempts: op.attempts,
    reconcileAttempts: op.reconcileAttempts,
    dispatchedAt: iso(op.dispatchedAt),
    completedAt: iso(op.completedAt),
    nextCheckAt: iso(op.nextReconcileAt),
    lastErrorCode: op.lastErrorCode,
    receipts: receipts.map(receiptView),
  };
}

export function fulfillmentView(row: FulfillmentRow): Fulfillment {
  return {
    id: toPublicId('fulfillment', row.id),
    kind: row.kind,
    state: row.state,
    source: row.source,
    estimateAt: iso(row.estimateAt),
    note: row.note,
    lastUpdateAt: row.lastUpdateAt.toISOString(),
  };
}

export function refundView(
  row: RefundRow,
  names: Map<string, string>,
  approval: RefundView['approval'],
): RefundView {
  const person = (id: string | null) =>
    id ? { id: toPublicId('staff', id), name: names.get(id) ?? 'Team member' } : null;
  return {
    id: toPublicId('refund', row.id),
    orderId: toPublicId('order', row.orderId),
    amountMinor: minor(row.amountMinor),
    currency: row.currency,
    lines: row.lines,
    reason: row.reason,
    note: row.note,
    state: row.state,
    requestedBy: person(row.requestedBy) as { id: string; name: string },
    requestedAt: row.requestedAt.toISOString(),
    approvedBy: person(row.approvedBy),
    approvedAt: iso(row.approvedAt),
    rejectedBy: person(row.rejectedBy),
    rejectionReason: row.rejectionReason,
    providerRef: row.providerRefundRef,
    failureReason: row.failureReason,
    succeededAt: iso(row.succeededAt),
    approval,
    operationId: row.operationId ? toPublicId('operation', row.operationId) : null,
  };
}

export function exceptionView(
  row: ExceptionRow,
  order: Pick<OrderRow, 'id' | 'reference'> | null,
  now: Date,
): FinanceExceptionView {
  return {
    id: toPublicId('financeException', row.id),
    kind: row.kind,
    state: row.state,
    order: order ? { id: toPublicId('order', order.id), reference: order.reference } : null,
    operationId: row.operationId ? toPublicId('operation', row.operationId) : null,
    sourceState: row.sourceState,
    nextSafeAction: row.nextSafeAction,
    evidence: row.evidence,
    openedAt: row.openedAt.toISOString(),
    ageSeconds: Math.max(
      0,
      Math.floor(((row.resolvedAt ?? now).getTime() - row.openedAt.getTime()) / 1000),
    ),
    resolvedAt: iso(row.resolvedAt),
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
  };
}

export function orderSummary(
  order: OrderRow,
  extras: {
    customerName: string | null;
    refundedMinor: bigint;
    openExceptions: number;
    pendingRefunds: number;
  },
): OrderSummary {
  return {
    id: toPublicId('order', order.id),
    reference: order.reference,
    brandId: toPublicId('brand', order.brandId),
    conversationId: toPublicId('conversation', order.conversationId),
    customer: { id: toPublicId('customer', order.principalId), displayName: extras.customerName },
    state: order.state,
    paymentState: order.paymentState,
    fulfillmentState: order.fulfillmentState,
    currency: order.currency,
    totalMinor: minor(order.totalMinor),
    refundedMinor: minor(extras.refundedMinor),
    placedAt: order.placedAt.toISOString(),
    openExceptions: extras.openExceptions,
    pendingRefunds: extras.pendingRefunds,
  };
}

/** Refund states as the customer is told them: never "refunded" before the provider says so. */
export function customerRefundState(
  state: RefundRow['state'],
): 'in_progress' | 'refunded' | 'not_refunded' {
  if (state === 'succeeded') return 'refunded';
  if (state === 'rejected' || state === 'failed') return 'not_refunded';
  return 'in_progress';
}

export function customerOrderView(
  order: OrderRow,
  refunds: RefundRow[],
  now: Date,
): z.infer<typeof CustomerOrderView> {
  const lines = order.lines as unknown as OrderLine[];
  return {
    id: toPublicId('order', order.id),
    reference: order.reference,
    state: order.state,
    paymentState: order.paymentState,
    fulfillmentState: order.fulfillmentState,
    currency: order.currency,
    totalMinor: minor(order.totalMinor),
    lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, totalMinor: l.totalMinor })),
    placedAt: order.placedAt.toISOString(),
    confirmedAt: iso(order.confirmedAt),
    refunds: refunds.map((r) => ({
      id: toPublicId('refund', r.id),
      amountMinor: minor(r.amountMinor),
      state: customerRefundState(r.state),
      updatedAt: r.updatedAt.toISOString(),
    })),
    observedAt: now.toISOString(),
  };
}
