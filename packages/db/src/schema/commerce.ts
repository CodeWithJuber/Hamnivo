import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals, secrets, staffMembers } from './identity.js';
import { operations } from './operations.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/**
 * Commerce (blueprint §23). The merchant owns its catalog and orders, the payment provider owns
 * payments; these tables hold Hamnivo's side: connections, what was quoted and approved, the
 * purchase attempts, projections of provider state and the exceptions people must resolve.
 * Money is bigint minor units; the currency is always stored next to it.
 */

export const MERCHANT_PROVIDERS = ['stripe', 'mock', 'whmcs'] as const;

/** Non-secret connection settings. Credentials live in `secrets`, never here. */
export interface MerchantConfig {
  currencies: string[];
  countries?: string[];
  shipping?: { amountMinor: string; label: string } | null;
  taxMode?: 'included' | 'none';
  /** How a refund is approved (C12). */
  refundPolicy: {
    approval: 'always' | 'above_threshold';
    autoApproveMaxMinor: string;
    requireSeparateApprover: boolean;
    windowDays: number | null;
  };
  /** Customer-facing terms shown before approval (U15). */
  terms?: { refundSummary?: string | null; termsUrl?: string | null } | null;
  /** Minutes a quote stays approvable (default 15). */
  quoteMinutes?: number;
  /** `mock` connections: which in-memory store to use. */
  mockStoreId?: string;
}

/** A brand's link to a merchant system (C01): provider, capability manifest and credentials. */
export const merchantConnections = pgTable(
  'merchant_connections',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    provider: text('provider', { enum: MERCHANT_PROVIDERS }).notNull(),
    /** Shown to customers as the seller (U15). */
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    /** The provider account events must come from (e.g. Stripe acct_…), when known. */
    providerAccountId: text('provider_account_id'),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull(),
    config: jsonb('config').$type<MerchantConfig>().notNull(),
    apiKeySecretId: uuid('api_key_secret_id'),
    webhookSecretId: uuid('webhook_secret_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('merchant_connections_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('merchant_connections_brand_active_key')
      .on(t.tenantId, t.brandId)
      .where(sql`${t.status} = 'active'`),
    foreignKey({
      name: 'merchant_connections_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'merchant_connections_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'merchant_connections_api_key_fk',
      columns: [t.tenantId, t.apiKeySecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'merchant_connections_webhook_secret_fk',
      columns: [t.tenantId, t.webhookSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'merchant_connections_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * What the merchant's catalog said at a moment (C02): items with variants, prices, currency,
 * availability and the source. Evidence for what was shown, never a price to charge (K06).
 */
export const catalogSnapshots = pgTable(
  'catalog_snapshots',
  {
    id: id(),
    tenantId: tenantId(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    conversationId: uuid('conversation_id'),
    query: text('query'),
    items: jsonb('items').$type<Record<string, unknown>[]>().notNull(),
    itemCount: integer('item_count').notNull(),
    source: text('source').notNull(),
    observedAt: tstz('observed_at').notNull(),
    createdByType: text('created_by_type', {
      enum: ['customer', 'staff', 'ai', 'system'],
    }).notNull(),
    createdById: text('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('catalog_snapshots_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'catalog_snapshots_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    foreignKey({
      name: 'catalog_snapshots_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    tenantIsolation(),
  ],
);

export const CART_STATES = ['open', 'locked', 'completed', 'abandoned'] as const;

export interface CartLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

/** A customer's cart in a conversation. Every edit bumps the revision (optimistic concurrency). */
export const carts = pgTable(
  'carts',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    status: text('status', { enum: CART_STATES }).notNull().default('open'),
    revision: integer('revision').notNull().default(1),
    currency: text('currency').notNull(),
    lines: jsonb('lines').$type<CartLine[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('carts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('carts_one_active_key')
      .on(t.tenantId, t.conversationId, t.principalId)
      .where(sql`${t.status} in ('open', 'locked')`),
    foreignKey({
      name: 'carts_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'carts_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'carts_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    check('carts_revision_ck', sql`${t.revision} > 0`),
    tenantIsolation(),
  ],
);

export const QUOTE_STATES = [
  'ready',
  'approved',
  'consumed',
  'expired',
  'superseded',
  'cancelled',
] as const;

/**
 * An exact quote from the merchant (C03). `document` is what the customer approves and `hash`
 * its canonical SHA-256; a trigger keeps both, and every amount, unchanged after creation.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    tenantId: tenantId(),
    cartId: uuid('cart_id').notNull(),
    cartRevision: integer('cart_revision').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    status: text('status', { enum: QUOTE_STATES }).notNull().default('ready'),
    /** Who must approve: the customer, or staff for staff-only actions. */
    approver: text('approver', { enum: ['customer', 'staff'] })
      .notNull()
      .default('customer'),
    currency: text('currency').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    hash: bytea('hash').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }),
    shippingMinor: bigint('shipping_minor', { mode: 'bigint' }),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdByType: text('created_by_type', {
      enum: ['customer', 'staff', 'ai', 'system'],
    }).notNull(),
    createdById: text('created_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('quotes_tenant_id_id_key').on(t.tenantId, t.id),
    index('quotes_cart_idx').on(t.tenantId, t.cartId),
    foreignKey({
      name: 'quotes_cart_fk',
      columns: [t.tenantId, t.cartId],
      foreignColumns: [carts.tenantId, carts.id],
    }),
    foreignKey({
      name: 'quotes_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'quotes_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'quotes_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    check('quotes_total_ck', sql`${t.totalMinor} >= 0`),
    tenantIsolation(),
  ],
);

export const PURCHASE_INTENT_STATES = [
  'draft',
  'quoted',
  'awaiting_approval',
  'approved',
  'executing',
  'completed',
  'expired',
  'cancelled',
  'denied',
  'failed',
  'needs_human',
  'unknown',
] as const;

/**
 * One purchase attempt for one quote (blueprint §23 purchase intent). The approval is stored
 * here: the exact hash and cart revision approved, when, by which customer, and a nonce.
 */
export const purchaseIntents = pgTable(
  'purchase_intents',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    cartId: uuid('cart_id').notNull(),
    quoteId: uuid('quote_id').notNull(),
    state: text('state', { enum: PURCHASE_INTENT_STATES }).notNull(),
    approvedHash: bytea('approved_hash'),
    approvedCartRevision: integer('approved_cart_revision'),
    approvedAt: tstz('approved_at'),
    approvalNonce: uuid('approval_nonce'),
    /** Session, origin and the language the card was shown in; no card data exists here. */
    approvalEvidence: jsonb('approval_evidence')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checkoutOperationId: uuid('checkout_operation_id'),
    checkoutSessionRef: text('checkout_session_ref'),
    checkoutUrl: text('checkout_url'),
    checkoutExpiresAt: tstz('checkout_expires_at'),
    /** Last customer-requested status check (rate limit). */
    lastCheckedAt: tstz('last_checked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_intents_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('purchase_intents_quote_key').on(t.tenantId, t.quoteId),
    uniqueIndex('purchase_intents_nonce_key')
      .on(t.tenantId, t.approvalNonce)
      .where(sql`${t.approvalNonce} is not null`),
    foreignKey({
      name: 'purchase_intents_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'purchase_intents_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'purchase_intents_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    foreignKey({
      name: 'purchase_intents_cart_fk',
      columns: [t.tenantId, t.cartId],
      foreignColumns: [carts.tenantId, carts.id],
    }),
    foreignKey({
      name: 'purchase_intents_quote_fk',
      columns: [t.tenantId, t.quoteId],
      foreignColumns: [quotes.tenantId, quotes.id],
    }),
    foreignKey({
      name: 'purchase_intents_operation_fk',
      columns: [t.tenantId, t.checkoutOperationId],
      foreignColumns: [operations.tenantId, operations.id],
    }),
    check(
      'purchase_intents_approval_ck',
      sql`${t.approvedAt} is null or (${t.approvedHash} is not null and ${t.approvalNonce} is not null)`,
    ),
    tenantIsolation(),
  ],
);

export const PAYMENT_STATES = [
  'not_started',
  'requires_action',
  'processing',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'unknown',
] as const;

/** Hamnivo's projection of the provider's payment for one purchase intent. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    tenantId: tenantId(),
    purchaseIntentId: uuid('purchase_intent_id').notNull(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    provider: text('provider').notNull(),
    sessionRef: text('session_ref').notNull(),
    paymentRef: text('payment_ref'),
    state: text('state', { enum: PAYMENT_STATES }).notNull().default('not_started'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    // drizzle-kit cannot serialize a bigint literal default, so the SQL default is written out.
    capturedMinor: bigint('captured_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    refundedMinor: bigint('refunded_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    capturedAt: tstz('captured_at'),
    /** Provider time of the newest event applied (events can arrive out of order). */
    lastEventAt: tstz('last_event_at'),
    lastSyncedAt: tstz('last_synced_at'),
    /** When to ask the provider again while no final outcome is known (lost webhooks). */
    nextSyncAt: tstz('next_sync_at'),
    syncAttempts: integer('sync_attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('payments_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('payments_intent_key').on(t.tenantId, t.purchaseIntentId),
    uniqueIndex('payments_session_key').on(t.tenantId, t.merchantConnectionId, t.sessionRef),
    index('payments_sync_idx').on(t.nextSyncAt).where(sql`${t.nextSyncAt} is not null`),
    foreignKey({
      name: 'payments_intent_fk',
      columns: [t.tenantId, t.purchaseIntentId],
      foreignColumns: [purchaseIntents.tenantId, purchaseIntents.id],
    }),
    foreignKey({
      name: 'payments_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    check(
      'payments_amounts_ck',
      sql`${t.capturedMinor} >= 0 and ${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.capturedMinor}`,
    ),
    tenantIsolation(),
  ],
);

export const ORDER_STATES = [
  'draft',
  'submitted',
  'confirmed',
  'partially_fulfilled',
  'fulfilled',
  'cancel_requested',
  'cancelled',
  'returned',
] as const;

/** The order. Payment and fulfilment keep their own states (C10). */
export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: tenantId(),
    /** Human reference shown to customers and staff, e.g. HV-7K3M9Q. */
    reference: text('reference').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    purchaseIntentId: uuid('purchase_intent_id').notNull(),
    quoteId: uuid('quote_id').notNull(),
    state: text('state', { enum: ORDER_STATES }).notNull(),
    /** Copy of the payment state for lists; the payments row is the source. */
    paymentState: text('payment_state', { enum: PAYMENT_STATES }).notNull(),
    fulfillmentState: text('fulfillment_state').notNull().default('not_started'),
    currency: text('currency').notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    lines: jsonb('lines').$type<Record<string, unknown>[]>().notNull(),
    deliverySummary: text('delivery_summary'),
    merchantOrderRef: text('merchant_order_ref'),
    placedAt: tstz('placed_at').notNull(),
    confirmedAt: tstz('confirmed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('orders_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('orders_reference_key').on(t.tenantId, t.reference),
    uniqueIndex('orders_intent_key').on(t.tenantId, t.purchaseIntentId),
    index('orders_placed_idx').on(t.tenantId, t.placedAt),
    index('orders_conversation_idx').on(t.tenantId, t.conversationId),
    foreignKey({
      name: 'orders_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'orders_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'orders_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    foreignKey({
      name: 'orders_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'orders_intent_fk',
      columns: [t.tenantId, t.purchaseIntentId],
      foreignColumns: [purchaseIntents.tenantId, purchaseIntents.id],
    }),
    foreignKey({
      name: 'orders_quote_fk',
      columns: [t.tenantId, t.quoteId],
      foreignColumns: [quotes.tenantId, quotes.id],
    }),
    tenantIsolation(),
  ],
);

export const FULFILLMENT_STATES = [
  'pending',
  'in_progress',
  'delayed',
  'shipped',
  'delivered',
  'provisioned',
  'failed',
  'cancelled',
] as const;

/** A shipment or a service activation for an order, with its own state and source. */
export const fulfillments = pgTable(
  'fulfillments',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind', { enum: ['shipment', 'service'] }).notNull(),
    state: text('state', { enum: FULFILLMENT_STATES }).notNull().default('pending'),
    source: text('source', { enum: ['merchant', 'staff'] }).notNull(),
    /** Only an estimate the merchant gave; never promised by Hamnivo. */
    estimateAt: tstz('estimate_at'),
    carrierRef: text('carrier_ref'),
    note: text('note'),
    lastUpdateAt: tstz('last_update_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('fulfillments_tenant_id_id_key').on(t.tenantId, t.id),
    index('fulfillments_order_idx').on(t.tenantId, t.orderId),
    foreignKey({
      name: 'fulfillments_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    tenantIsolation(),
  ],
);

export const REFUND_STATES = [
  'requested',
  'policy_checked',
  'awaiting_approval',
  'submitted',
  'pending',
  'succeeded',
  'rejected',
  'failed',
  'unknown',
] as const;

export const REFUND_REASONS = [
  'customer_request',
  'damaged',
  'not_delivered',
  'duplicate',
  'other',
] as const;

/** A refund (C12): requested by staff, approved per policy, executed and confirmed by provider. */
export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Order lines and quantities refunded, when the refund is per item. */
    lines: jsonb('lines').$type<{ lineId: string; quantity: number }[]>().notNull().default([]),
    reason: text('reason', { enum: REFUND_REASONS }).notNull(),
    /** Internal note, visible to staff only. */
    note: text('note'),
    state: text('state', { enum: REFUND_STATES }).notNull().default('requested'),
    clientRequestId: uuid('client_request_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: tstz('approved_at'),
    rejectedBy: uuid('rejected_by'),
    rejectedAt: tstz('rejected_at'),
    rejectionReason: text('rejection_reason'),
    /** The policy evaluation at request time (eligibility, refundable amount, approval need). */
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull(),
    operationId: uuid('operation_id'),
    providerRefundRef: text('provider_refund_ref'),
    failureReason: text('failure_reason'),
    succeededAt: tstz('succeeded_at'),
    nextSyncAt: tstz('next_sync_at'),
    syncAttempts: integer('sync_attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('refunds_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('refunds_client_request_key').on(t.tenantId, t.orderId, t.clientRequestId),
    index('refunds_order_idx').on(t.tenantId, t.orderId),
    index('refunds_sync_idx').on(t.nextSyncAt).where(sql`${t.nextSyncAt} is not null`),
    foreignKey({
      name: 'refunds_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: 'refunds_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    foreignKey({
      name: 'refunds_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'refunds_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'refunds_rejected_by_fk',
      columns: [t.tenantId, t.rejectedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'refunds_operation_fk',
      columns: [t.tenantId, t.operationId],
      foreignColumns: [operations.tenantId, operations.id],
    }),
    check('refunds_amount_ck', sql`${t.amountMinor} > 0`),
    tenantIsolation(),
  ],
);

export const FINANCE_EXCEPTION_KINDS = [
  'payment_unknown',
  'refund_unknown',
  'order_update_pending',
  'amount_mismatch',
  'reconcile_exhausted',
  'refund_failed',
  'provisioning_failed',
] as const;

export const NEXT_SAFE_ACTIONS = [
  'check_status',
  'wait_for_provider',
  'contact_provider',
  'review_order',
  'retry_refund',
] as const;

/**
 * Money situations that need a person (C19): unknown outcomes, failed refunds, a paid order
 * whose update is pending. Each shows its evidence and the next safe action; resolving one is
 * audited and never moves money by itself.
 */
export const financeExceptions = pgTable(
  'finance_exceptions',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind', { enum: FINANCE_EXCEPTION_KINDS }).notNull(),
    state: text('state', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    subjectType: text('subject_type', {
      enum: ['operation', 'payment', 'refund', 'order'],
    }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    operationId: uuid('operation_id'),
    orderId: uuid('order_id'),
    /** The provider-side state last observed, in the provider's words (e.g. `pending`). */
    sourceState: text('source_state').notNull(),
    nextSafeAction: text('next_safe_action', { enum: NEXT_SAFE_ACTIONS }).notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    openedAt: tstz('opened_at').notNull(),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    resolution: text('resolution', {
      enum: ['provider_confirmed', 'manual_review', 'refunded_elsewhere', 'written_off'],
    }),
    resolutionNote: text('resolution_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('finance_exceptions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('finance_exceptions_open_key')
      .on(t.tenantId, t.kind, t.subjectId)
      .where(sql`${t.state} = 'open'`),
    index('finance_exceptions_state_idx').on(t.tenantId, t.state, t.openedAt),
    foreignKey({
      name: 'finance_exceptions_operation_fk',
      columns: [t.tenantId, t.operationId],
      foreignColumns: [operations.tenantId, operations.id],
    }),
    foreignKey({
      name: 'finance_exceptions_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: 'finance_exceptions_resolved_by_fk',
      columns: [t.tenantId, t.resolvedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Verified provider webhooks (C08), stored once per provider event id and acknowledged before
 * processing. Only the normalized event is kept (no customer details); `body_hash` is the
 * SHA-256 of the exact bytes that were verified.
 */
export const commerceEvents = pgTable(
  'commerce_events',
  {
    id: id(),
    tenantId: tenantId(),
    merchantConnectionId: uuid('merchant_connection_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    providerType: text('provider_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    bodyHash: bytea('body_hash').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    availableAt: tstz('available_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    processedAt: tstz('processed_at'),
    outcome: text('outcome', { enum: ['applied', 'ignored', 'stale'] }),
    lastError: text('last_error'),
  },
  (t) => [
    unique('commerce_events_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('commerce_events_provider_key').on(
      t.tenantId,
      t.merchantConnectionId,
      t.providerEventId,
    ),
    index('commerce_events_pending_idx').on(t.availableAt).where(sql`${t.processedAt} is null`),
    foreignKey({
      name: 'commerce_events_merchant_fk',
      columns: [t.tenantId, t.merchantConnectionId],
      foreignColumns: [merchantConnections.tenantId, merchantConnections.id],
    }),
    tenantIsolation(),
  ],
);
