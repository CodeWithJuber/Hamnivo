import type { CommerceCapabilities } from '@hamnivo/domain/commerce';

/**
 * The commerce port (blueprint §25 CommercePort). A provider adapter speaks for one merchant
 * connection: its catalog, its prices, its hosted checkout and its refunds. Amounts cross the
 * port as integer minor units (bigint); no provider type crosses it, and the gateway never
 * computes a price itself: quotes come from the provider every time (K06).
 */

export type ProviderKind = 'stripe' | 'mock' | 'whmcs';

export interface CatalogItem {
  productId: string;
  /** Provider price or variant reference; null when the product has one price. */
  variantId: string | null;
  name: string;
  description: string | null;
  unitPriceMinor: bigint;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  /** Units in stock when the merchant reports it; null otherwise. */
  stockQuantity: number | null;
  /** Billing period of a subscription price; null for one-time prices. */
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number } | null;
  imageUrl: string | null;
}

export interface CatalogResult {
  items: CatalogItem[];
  /** When the merchant was read. Shown with the items; prices are re-read for every quote. */
  observedAt: Date;
  /** Which provider endpoint answered, for evidence (e.g. `stripe:prices.list`). */
  source: string;
}

export interface QuoteRequestLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface QuoteRequest {
  lines: QuoteRequestLine[];
  currency: string;
  /** Delivery country (ISO 3166-1 alpha-2), when goods are shipped. */
  country?: string | null;
}

export interface ProviderQuoteLine {
  productId: string;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: bigint;
  totalMinor: bigint;
}

export interface ProviderQuote {
  currency: string;
  lines: ProviderQuoteLine[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint | null;
  taxMode: 'included' | 'exclusive' | 'none';
  shippingMinor: bigint | null;
  totalMinor: bigint;
  /** Recurring checkout is not offered yet, so quotes are one-time (null). */
  recurring: null;
  /** How long the merchant holds these prices; null when it does not say. */
  validUntil: Date | null;
  observedAt: Date;
}

export interface CheckoutRequest {
  /** Hamnivo's operation id: sent as the provider's client reference and in metadata. */
  reference: string;
  /** Provider idempotency key: the same key never creates a second session. */
  idempotencyKey: string;
  quote: ProviderQuote;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  locale?: string | null;
  /** Non-sensitive references only (tenant, order, intent ids). */
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  id: string;
  /** The hosted payment page; null once the session is complete or expired. */
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  /** Provider payment reference (Stripe PaymentIntent id) once a payment exists. */
  paymentRef: string | null;
  amountTotalMinor: bigint | null;
  currency: string | null;
  /** Our reference as the provider stored it. */
  reference: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
}

export interface RefundRequest {
  reference: string;
  idempotencyKey: string;
  paymentRef: string;
  amountMinor: bigint;
  currency: string;
  reason: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  metadata: Record<string, string>;
}

export interface ProviderRefund {
  id: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
  amountMinor: bigint;
  currency: string;
  paymentRef: string | null;
  reference: string | null;
  failureReason: string | null;
  createdAt: Date;
}

export type NormalizedEventType =
  | 'checkout.completed'
  | 'checkout.async_succeeded'
  | 'checkout.async_failed'
  | 'checkout.expired'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.processing'
  | 'payment.requires_action'
  | 'refund.updated'
  | 'ignored';

/** A verified provider event, reduced to what Hamnivo acts on. */
export interface NormalizedEvent {
  id: string;
  type: NormalizedEventType;
  /** The provider's own event name, for evidence. */
  providerType: string;
  occurredAt: Date;
  /** The provider account the event belongs to, when the provider says. */
  account: string | null;
  livemode: boolean;
  checkout?: CheckoutSession;
  refund?: ProviderRefund;
  paymentRef?: string | null;
  /** Our reference from metadata, when present. */
  reference?: string | null;
}

export interface CommerceProvider {
  readonly kind: ProviderKind;
  capabilities(): CommerceCapabilities;
  searchCatalog(query: { text?: string; limit: number }): Promise<CatalogResult>;
  quote(request: QuoteRequest): Promise<ProviderQuote>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  getCheckout(sessionId: string): Promise<CheckoutSession>;
  /**
   * Finds the session created for `reference` without ever creating one. This is how a
   * checkout whose creation timed out is resolved (C09).
   */
  findCheckout(reference: string, createdAfter: Date): Promise<CheckoutSession | null>;
  /** Ends an unpaid session so it can no longer be paid (safe cancel). */
  expireCheckout(sessionId: string): Promise<CheckoutSession>;
  createRefund(request: RefundRequest): Promise<ProviderRefund>;
  getRefund(refundId: string): Promise<ProviderRefund>;
  /** Finds the refund made for `reference` on a payment, without creating one. */
  findRefund(reference: string, paymentRef: string): Promise<ProviderRefund | null>;
  /** Verifies the signature over the exact raw body and normalizes the event. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
    now?: Date,
  ): NormalizedEvent;
}
