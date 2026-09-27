import { z } from 'zod';
import { QuoteCard } from './cards.js';
import { CurrencyCode, MinorUnits, Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Commerce API (blueprint §23, C01–C12, C19). Amounts are integer minor units as strings with an
 * ISO 4217 currency next to them; prices, stock and order state are read live (K06), and every
 * response is sent with `Cache-Control: no-store`.
 */

const Hash = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 hex digest');

// ── Merchant connections (C01, E02) ──────────────────────────────────────────────────────────

export const MerchantProvider = z.enum(['stripe', 'mock']).meta({ id: 'MerchantProvider' });

export const CommerceCapabilities = z
  .object({
    version: z.literal(1),
    provider: z.string(),
    apiVersion: z.string(),
    catalog: z.object({ search: z.boolean(), variants: z.boolean(), stock: z.boolean() }),
    checkout: z.object({ hosted: z.boolean(), authorizationOnly: z.boolean() }),
    refunds: z.object({ full: z.boolean(), partial: z.boolean() }),
    cancellation: z.boolean(),
    recurring: z.boolean(),
    provisioning: z.boolean(),
    currencies: z.array(CurrencyCode),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
    tax: z.enum(['included', 'exclusive', 'none']),
  })
  .meta({ id: 'CommerceCapabilities' });

export const RefundPolicy = z
  .object({
    /** `always`: every refund needs approval; `above_threshold`: small ones go straight through. */
    approval: z.enum(['always', 'above_threshold']).default('always'),
    autoApproveMaxMinor: MinorUnits.default('0'),
    /** The person who asks for a refund cannot approve it. */
    requireSeparateApprover: z.boolean().default(true),
    windowDays: z.int().min(1).max(3650).nullable().default(null),
  })
  .meta({ id: 'RefundPolicy' });

export const MerchantTerms = z
  .object({
    refundSummary: z.string().trim().max(300).nullable().default(null),
    termsUrl: z.url().nullable().default(null),
  })
  .meta({ id: 'MerchantTerms' });

export const MerchantConnection = z
  .object({
    id: typeId('merchant'),
    brandId: typeId('brand'),
    provider: MerchantProvider,
    displayName: z.string(),
    status: z.enum(['active', 'disabled']),
    providerAccountId: z.string().nullable(),
    currencies: z.array(CurrencyCode),
    shipping: z.object({ amountMinor: MinorUnits, label: z.string() }).nullable(),
    capabilities: CommerceCapabilities,
    refundPolicy: RefundPolicy,
    terms: MerchantTerms,
    quoteMinutes: z.int(),
    /** Point the provider's webhooks here (e.g. Stripe dashboard → Webhooks). */
    webhookUrl: z.url(),
    /** Write-only credentials: only whether they are set and their last characters. */
    credentials: z.object({ apiKey: z.string().nullable(), webhookSecret: z.string().nullable() }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'MerchantConnection' });
export type MerchantConnection = z.infer<typeof MerchantConnection>;

const ShippingInput = z.object({
  amountMinor: MinorUnits,
  label: z.string().trim().min(1).max(60),
});

export const CreateMerchantConnectionRequest = z
  .object({
    brandId: typeId('brand'),
    provider: MerchantProvider,
    displayName: z.string().trim().min(1).max(80),
    /** Stripe secret or restricted key; stored encrypted and never shown again. */
    apiKey: z.string().trim().min(8).max(500).optional(),
    /** The provider's webhook signing secret (Stripe `whsec_…`). */
    webhookSecret: z.string().trim().min(8).max(500).optional(),
    providerAccountId: z.string().trim().max(100).optional(),
    currencies: z.array(CurrencyCode).min(1).max(20),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .default([]),
    shipping: ShippingInput.nullable().default(null),
    refundPolicy: RefundPolicy.prefault({}),
    terms: MerchantTerms.prefault({}),
    quoteMinutes: z.int().min(5).max(60).default(15),
    /** `mock` connections only: the in-memory store to use. */
    mockStoreId: z.string().trim().min(1).max(80).optional(),
  })
  .meta({ id: 'CreateMerchantConnectionRequest' });

export const UpdateMerchantConnectionRequest = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    apiKey: z.string().trim().min(8).max(500).optional(),
    webhookSecret: z.string().trim().min(8).max(500).optional(),
    currencies: z.array(CurrencyCode).min(1).max(20).optional(),
    shipping: ShippingInput.nullable().optional(),
    refundPolicy: RefundPolicy.optional(),
    terms: MerchantTerms.optional(),
    quoteMinutes: z.int().min(5).max(60).optional(),
  })
  .meta({ id: 'UpdateMerchantConnectionRequest' });

// ── Customer side: catalog, cart, quote, approval, checkout (C02–C06, U15) ───────────────────

export const CartLineInput = z.object({
  productId: z.string().trim().min(1).max(200),
  variantId: z.string().trim().min(1).max(200).nullable().default(null),
  quantity: z.int().min(1).max(99),
});

export const UpdateCartRequest = z
  .object({
    /** The revision you edited; null to start a cart. Another revision means someone changed it. */
    expectedRevision: z.int().positive().nullable(),
    lines: z.array(CartLineInput).max(20),
    /** The catalog card the items were chosen from. */
    catalogId: typeId('catalog').optional(),
  })
  .meta({ id: 'UpdateCartRequest' });

export const CartView = z
  .object({
    id: typeId('cart'),
    revision: z.int().positive(),
    status: z.enum(['open', 'locked', 'completed', 'abandoned']),
    merchant: z.object({ id: typeId('merchant'), name: z.string() }),
    currency: CurrencyCode,
    lines: z.array(
      z.object({
        productId: z.string(),
        variantId: z.string().nullable(),
        name: z.string().nullable(),
        quantity: z.int().positive(),
        /** The catalog price last shown, as an estimate; the quote is exact. */
        unitPriceMinor: MinorUnits.nullable(),
      }),
    ),
    itemCount: z.int().nonnegative(),
    estimatedSubtotalMinor: MinorUnits.nullable(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'CartView' });
export type CartView = z.infer<typeof CartView>;

/** The shop a conversation can buy from, if the brand sells in chat. */
export const ShopInfo = z
  .object({ merchantId: typeId('merchant'), name: z.string(), currency: CurrencyCode })
  .meta({ id: 'ShopInfo' });
export type ShopInfo = z.infer<typeof ShopInfo>;

export const CatalogSearchRequest = z
  .object({ query: z.string().trim().max(200).optional() })
  .meta({ id: 'CatalogSearchRequest' });

export const RequestQuoteRequest = z
  .object({ cartRevision: z.int().positive() })
  .meta({ id: 'RequestQuoteRequest' });

/** Exactly what the customer approves; its canonical SHA-256 is the quote hash. */
export const QuoteDocument = z
  .object({
    v: z.literal(1),
    quoteId: z.string(),
    merchant: z.object({ connectionId: z.string(), name: z.string() }),
    cart: z.object({ id: z.string(), revision: z.int().positive() }),
    currency: CurrencyCode,
    lines: z.array(
      z.object({
        lineId: z.string(),
        productId: z.string(),
        variantId: z.string().nullable(),
        name: z.string(),
        quantity: z.int().positive(),
        unitPriceMinor: MinorUnits,
        totalMinor: MinorUnits,
      }),
    ),
    subtotalMinor: MinorUnits,
    discountMinor: MinorUnits,
    taxMinor: MinorUnits.nullable(),
    taxMode: z.enum(['included', 'exclusive', 'none']),
    shippingMinor: MinorUnits.nullable(),
    totalMinor: MinorUnits,
    recurring: z
      .object({ interval: z.enum(['week', 'month', 'year']), intervalCount: z.int().positive() })
      .nullable(),
    delivery: z.string().nullable(),
    expiresAt: Timestamp,
  })
  .meta({ id: 'QuoteDocument' });

export const PurchaseOutcome = z
  .enum([
    'awaiting_approval',
    'preparing_checkout',
    'awaiting_payment',
    'confirming',
    'paid',
    'failed',
    'expired',
    'cancelled',
    'needs_human',
  ])
  .meta({
    id: 'PurchaseOutcome',
    description:
      'What the customer is told. "paid" only with the provider\'s receipt; a browser return is "confirming".',
  });

export const PurchaseIntentView = z
  .object({
    id: typeId('purchase'),
    quoteId: typeId('quote'),
    state: z.string(),
    outcome: PurchaseOutcome,
    checkout: z.object({ url: z.url().nullable(), expiresAt: Timestamp.nullable() }).nullable(),
    order: z.object({ id: typeId('order'), reference: z.string() }).nullable(),
    payment: z
      .object({
        state: z.string(),
        amountMinor: MinorUnits,
        currency: CurrencyCode,
        confirmedAt: Timestamp.nullable(),
      })
      .nullable(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'PurchaseIntentView' });
export type PurchaseIntentView = z.infer<typeof PurchaseIntentView>;

export const QuoteView = z
  .object({
    id: typeId('quote'),
    /** `expired` as soon as the expiry passes, even before anything is written. */
    status: z.enum(['ready', 'approved', 'consumed', 'expired', 'superseded', 'cancelled']),
    approver: z.enum(['customer', 'staff']),
    hash: Hash,
    document: QuoteDocument,
    card: QuoteCard,
    /** Who sells, what the assistant does and where payment happens (U15). */
    transparency: z.object({
      seller: z.string(),
      paymentPage: z.literal('provider_hosted'),
      recurring: z.boolean(),
      refundSummary: z.string().nullable(),
      termsUrl: z.url().nullable(),
    }),
    expiresAt: Timestamp,
    intent: PurchaseIntentView.nullable(),
  })
  .meta({ id: 'QuoteView' });
export type QuoteView = z.infer<typeof QuoteView>;

export const ApproveQuoteRequest = z
  .object({
    /** The hash of the document you were shown; recomputed by the widget before approving. */
    quoteHash: Hash,
    cartRevision: z.int().positive(),
    /** Makes a repeated tap safe: the same id returns the same purchase. */
    clientRequestId: z.uuid(),
  })
  .meta({ id: 'ApproveQuoteRequest' });

export const CustomerRefundState = z.enum(['in_progress', 'refunded', 'not_refunded']);

export const CustomerOrderView = z
  .object({
    id: typeId('order'),
    reference: z.string(),
    state: z.string(),
    paymentState: z.string(),
    fulfillmentState: z.string(),
    currency: CurrencyCode,
    totalMinor: MinorUnits,
    lines: z.array(
      z.object({ name: z.string(), quantity: z.int().positive(), totalMinor: MinorUnits }),
    ),
    placedAt: Timestamp,
    confirmedAt: Timestamp.nullable(),
    refunds: z.array(
      z.object({
        id: typeId('refund'),
        amountMinor: MinorUnits,
        state: CustomerRefundState,
        updatedAt: Timestamp,
      }),
    ),
    /** When Hamnivo last read the order and payment records. */
    observedAt: Timestamp,
  })
  .meta({ id: 'CustomerOrderView' });
export type CustomerOrderView = z.infer<typeof CustomerOrderView>;

// ── Staff side: orders, refunds, exceptions (C10, C12, C19, R07) ─────────────────────────────

export const ReceiptView = z
  .object({
    id: typeId('receipt'),
    kind: z.enum(['dispatch', 'response', 'webhook', 'reconcile', 'manual']),
    outcome: z.enum(['pending', 'succeeded', 'failed', 'unknown']),
    source: z.enum(['provider_api', 'provider_webhook', 'reconciler', 'staff']),
    providerRef: z.string().nullable(),
    providerEventId: z.string().nullable(),
    observedAt: Timestamp,
  })
  .meta({ id: 'ReceiptView' });

export const OperationView = z
  .object({
    id: typeId('operation'),
    kind: z.string(),
    state: z.enum(['pending', 'dispatched', 'succeeded', 'failed', 'unknown', 'cancelled']),
    provider: z.string().nullable(),
    providerRef: z.string().nullable(),
    actor: z.enum(['customer', 'staff', 'ai', 'system']),
    attempts: z.int(),
    reconcileAttempts: z.int(),
    dispatchedAt: Timestamp.nullable(),
    completedAt: Timestamp.nullable(),
    nextCheckAt: Timestamp.nullable(),
    lastErrorCode: z.string().nullable(),
    receipts: z.array(ReceiptView),
  })
  .meta({ id: 'OperationView' });

export const RefundReason = z.enum([
  'customer_request',
  'damaged',
  'not_delivered',
  'duplicate',
  'other',
]);

export const RefundView = z
  .object({
    id: typeId('refund'),
    orderId: typeId('order'),
    amountMinor: MinorUnits,
    currency: CurrencyCode,
    lines: z.array(z.object({ lineId: z.string(), quantity: z.int().positive() })),
    reason: RefundReason,
    note: z.string().nullable(),
    state: z.enum([
      'requested',
      'policy_checked',
      'awaiting_approval',
      'submitted',
      'pending',
      'succeeded',
      'rejected',
      'failed',
      'unknown',
    ]),
    requestedBy: z.object({ id: typeId('staff'), name: z.string() }),
    requestedAt: Timestamp,
    approvedBy: z.object({ id: typeId('staff'), name: z.string() }).nullable(),
    approvedAt: Timestamp.nullable(),
    rejectedBy: z.object({ id: typeId('staff'), name: z.string() }).nullable(),
    rejectionReason: z.string().nullable(),
    providerRef: z.string().nullable(),
    failureReason: z.string().nullable(),
    succeededAt: Timestamp.nullable(),
    /** Whether the person asking may approve it, and why not. */
    approval: z.object({
      required: z.boolean(),
      canApprove: z.boolean(),
      reason: z.enum(['same_person', 'no_permission', 'not_awaiting']).nullable(),
    }),
    operationId: typeId('operation').nullable(),
  })
  .meta({ id: 'RefundView' });
export type RefundView = z.infer<typeof RefundView>;

export const FinanceExceptionView = z
  .object({
    id: typeId('financeException'),
    kind: z.enum([
      'payment_unknown',
      'refund_unknown',
      'order_update_pending',
      'amount_mismatch',
      'reconcile_exhausted',
      'refund_failed',
      'provisioning_failed',
    ]),
    state: z.enum(['open', 'resolved']),
    order: z.object({ id: typeId('order'), reference: z.string() }).nullable(),
    operationId: typeId('operation').nullable(),
    sourceState: z.string(),
    nextSafeAction: z.enum([
      'check_status',
      'wait_for_provider',
      'contact_provider',
      'review_order',
      'retry_refund',
    ]),
    evidence: z.record(z.string(), z.unknown()),
    openedAt: Timestamp,
    /** Seconds since the exception opened (the pending age). */
    ageSeconds: z.int().nonnegative(),
    resolvedAt: Timestamp.nullable(),
    resolution: z
      .enum(['provider_confirmed', 'manual_review', 'refunded_elsewhere', 'written_off'])
      .nullable(),
    resolutionNote: z.string().nullable(),
  })
  .meta({ id: 'FinanceExceptionView' });
export type FinanceExceptionView = z.infer<typeof FinanceExceptionView>;

export const FulfillmentView = z.object({
  id: typeId('fulfillment'),
  kind: z.enum(['shipment', 'service']),
  state: z.enum([
    'pending',
    'in_progress',
    'delayed',
    'shipped',
    'delivered',
    'provisioned',
    'failed',
    'cancelled',
  ]),
  source: z.enum(['merchant', 'staff']),
  estimateAt: Timestamp.nullable(),
  note: z.string().nullable(),
  lastUpdateAt: Timestamp,
});

export const OrderSummary = z
  .object({
    id: typeId('order'),
    reference: z.string(),
    brandId: typeId('brand'),
    conversationId: typeId('conversation'),
    customer: z.object({ id: typeId('customer'), displayName: z.string().nullable() }),
    state: z.string(),
    paymentState: z.string(),
    fulfillmentState: z.string(),
    currency: CurrencyCode,
    totalMinor: MinorUnits,
    refundedMinor: MinorUnits,
    placedAt: Timestamp,
    openExceptions: z.int().nonnegative(),
    pendingRefunds: z.int().nonnegative(),
  })
  .meta({ id: 'OrderSummary' });
export type OrderSummary = z.infer<typeof OrderSummary>;

export const OrderDetail = z
  .object({
    order: OrderSummary,
    merchant: z.object({ id: typeId('merchant'), name: z.string(), provider: MerchantProvider }),
    lines: z.array(
      z.object({
        lineId: z.string(),
        name: z.string(),
        quantity: z.int().positive(),
        unitPriceMinor: MinorUnits,
        totalMinor: MinorUnits,
      }),
    ),
    shippingMinor: MinorUnits.nullable(),
    deliverySummary: z.string().nullable(),
    payment: z
      .object({
        state: z.string(),
        amountMinor: MinorUnits,
        capturedMinor: MinorUnits,
        refundedMinor: MinorUnits,
        capturedAt: Timestamp.nullable(),
        providerRef: z.string().nullable(),
      })
      .nullable(),
    refundable: z.object({
      maxMinor: MinorUnits,
      partial: z.boolean(),
      policy: RefundPolicy,
    }),
    fulfillments: z.array(FulfillmentView),
    refunds: z.array(RefundView),
    operations: z.array(OperationView),
    exceptions: z.array(FinanceExceptionView),
    /** When the records were read; nothing here comes from a cache (K06). */
    observedAt: Timestamp,
  })
  .meta({ id: 'OrderDetail' });
export type OrderDetail = z.infer<typeof OrderDetail>;

export const CreateRefundRequest = z
  .object({
    clientRequestId: z.uuid(),
    amountMinor: MinorUnits,
    lines: z
      .array(z.object({ lineId: z.string(), quantity: z.int().positive() }))
      .max(50)
      .default([]),
    reason: RefundReason,
    note: z.string().trim().max(1000).optional(),
  })
  .meta({ id: 'CreateRefundRequest' });

export const RejectRefundRequest = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .meta({ id: 'RejectRefundRequest' });

export const ResolveExceptionRequest = z
  .object({
    resolution: z.enum([
      'provider_confirmed',
      'manual_review',
      'refunded_elsewhere',
      'written_off',
    ]),
    note: z.string().trim().min(1).max(1000),
  })
  .meta({ id: 'ResolveExceptionRequest' });

export const RecordFulfillmentRequest = z
  .object({
    kind: z.enum(['shipment', 'service']),
    state: z.enum(['in_progress', 'delayed', 'shipped', 'delivered', 'provisioned', 'failed']),
    note: z.string().trim().max(500).optional(),
    estimateAt: Timestamp.optional(),
    carrierRef: z.string().trim().max(120).optional(),
  })
  .meta({ id: 'RecordFulfillmentRequest' });

export const ShareCatalogRequest = z
  .object({
    query: z.string().trim().max(200).optional(),
    productIds: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  })
  .meta({ id: 'ShareCatalogRequest' });

export const ConversationCommerce = z
  .object({
    orders: z.array(OrderSummary),
    /** Operations still owed an outcome (R07): kept and reconciled whoever owns the chat. */
    inFlight: z.array(OperationView),
  })
  .meta({ id: 'ConversationCommerce' });
