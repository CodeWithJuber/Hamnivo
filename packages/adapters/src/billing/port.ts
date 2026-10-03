/**
 * The billing-provider port: how a workspace pays Hamnivo's operator for its plan. A provider
 * speaks for the whole server (one Stripe account, one WHMCS installation), never for a merchant.
 * No provider type crosses the port: subscriptions, invoices and webhook events are reduced to
 * what billing acts on, and amounts are integer minor units (bigint).
 *
 * - `free`: no payments; every workspace stays on the plan the operator gives it (the default).
 * - `stripe`: Stripe Billing. Checkout Sessions start subscriptions, the Customer Portal manages
 *   them, and signed webhooks report every change.
 * - `whmcs`: WHMCS sells and bills; it drives Hamnivo through the operator API (the WHMCS module
 *   in integrations/whmcs), so the port only knows where its client area is.
 */

export type BillingProviderName = 'free' | 'stripe' | 'whmcs';

/** Subscription states as Stripe names them (`incomplete_expired` reads as `canceled`). */
export type SubscriptionState =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export interface BillingCapabilities {
  /** Studio can start a subscription (Upgrade). */
  checkout: boolean;
  /** Studio can send the person to a self-service page (Manage). */
  portal: boolean;
  /** Invoices can be listed from the provider. */
  invoices: boolean;
  /** The provider reports changes through signed webhooks. */
  webhooks: boolean;
}

export interface CustomerRequest {
  /** The workspace's public id (`tnt_…`), stored with the customer. */
  tenantRef: string;
  name: string;
  email: string | null;
  /** Same key, same customer: a retry after a lost answer never makes a second one. */
  idempotencyKey: string;
}

export interface CheckoutRequest {
  tenantRef: string;
  customerRef: string;
  planKey: string;
  /** The provider's price for the plan (Stripe `price_…`). */
  priceRef: string;
  /** Days of free trial before the first charge; 0: none. */
  trialDays: number;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface PortalRequest {
  customerRef: string;
  returnUrl: string;
}

export interface ProviderSubscription {
  ref: string;
  customerRef: string | null;
  state: SubscriptionState;
  /** The price billed (one price per subscription). */
  priceRef: string | null;
  /** The workspace and plan recorded when the subscription started (metadata). */
  tenantRef: string | null;
  planKey: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

export interface ProviderInvoice {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: string;
  totalMinor: bigint;
  amountPaidMinor: bigint;
  createdAt: Date;
  paidAt: Date | null;
  /** The provider's page for the invoice (pay or download). */
  url: string | null;
  pdfUrl: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  /** The workspace recorded on the subscription when the invoice was finalized. */
  tenantRef: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
}

interface EventBase {
  /** The provider's event id, the key that applies each event once. */
  id: string;
  providerType: string;
  occurredAt: Date;
  livemode: boolean;
}

export type BillingEvent =
  | (EventBase & { kind: 'subscription.changed'; subscription: ProviderSubscription })
  | (EventBase & { kind: 'subscription.deleted'; subscription: ProviderSubscription })
  | (EventBase & { kind: 'invoice.paid'; invoice: ProviderInvoice })
  | (EventBase & { kind: 'invoice.payment_failed'; invoice: ProviderInvoice })
  | (EventBase & {
      kind: 'checkout.completed';
      tenantRef: string | null;
      customerRef: string | null;
      subscriptionRef: string | null;
    })
  | (EventBase & { kind: 'ignored' });

export interface BillingProvider {
  readonly name: BillingProviderName;
  capabilities(): BillingCapabilities;
  /** Creates the workspace's customer at the provider (idempotent by key). */
  createCustomer(request: CustomerRequest): Promise<{ customerRef: string }>;
  /** A hosted checkout page that starts a subscription to the plan. */
  createCheckout(request: CheckoutRequest): Promise<{ url: string; ref: string }>;
  /** A hosted page where the customer changes or cancels the subscription and its payment method. */
  createPortal(request: PortalRequest): Promise<{ url: string }>;
  listInvoices(customerRef: string, limit: number): Promise<ProviderInvoice[]>;
  /** The subscription as the provider sees it now; null when it does not exist. */
  getSubscription(ref: string): Promise<ProviderSubscription | null>;
  /**
   * Checks the signature over the exact raw body and reads the event. Throws
   * BillingWebhookSignatureError when the request does not come from the provider.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
    now?: Date,
  ): BillingEvent;
}

export type BillingProviderErrorKind =
  | 'unsupported'
  | 'network'
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'auth'
  | 'invalid_request'
  | 'not_found'
  | 'unknown';

/** A failed provider call, with whether repeating it (with the same key) may help. */
export class BillingProviderError extends Error {
  override name = 'BillingProviderError';
  constructor(
    readonly kind: BillingProviderErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export class BillingWebhookSignatureError extends Error {
  override name = 'BillingWebhookSignatureError';
  constructor(readonly reason: 'missing' | 'stale' | 'malformed' | 'mismatch') {
    super(`Billing webhook signature ${reason}`);
  }
}

const unsupported = (provider: string, what: string) =>
  new BillingProviderError('unsupported', `${provider} does not support ${what}`, false);

/** No payments: plans are given by the operator; nothing is ever sent anywhere. */
export class FreeBillingProvider implements BillingProvider {
  readonly name = 'free' as const;

  capabilities(): BillingCapabilities {
    return { checkout: false, portal: false, invoices: false, webhooks: false };
  }

  async createCustomer(): Promise<{ customerRef: string }> {
    throw unsupported('The free provider', 'customers');
  }

  async createCheckout(): Promise<{ url: string; ref: string }> {
    throw unsupported('The free provider', 'checkout');
  }

  async createPortal(): Promise<{ url: string }> {
    throw unsupported('The free provider', 'a billing portal');
  }

  async listInvoices(): Promise<ProviderInvoice[]> {
    return [];
  }

  async getSubscription(): Promise<ProviderSubscription | null> {
    return null;
  }

  verifyWebhook(): BillingEvent {
    throw new BillingWebhookSignatureError('mismatch');
  }
}

/**
 * WHMCS sells and bills the plans; its server module calls Hamnivo's operator API to create,
 * suspend, reactivate, close and re-plan workspaces. Studio sends people to the client area.
 */
export class WhmcsBillingProvider implements BillingProvider {
  readonly name = 'whmcs' as const;

  constructor(private readonly options: { clientAreaUrl: string | null }) {}

  capabilities(): BillingCapabilities {
    return {
      checkout: false,
      portal: this.options.clientAreaUrl !== null,
      invoices: false,
      webhooks: false,
    };
  }

  async createCustomer(): Promise<{ customerRef: string }> {
    throw unsupported('WHMCS', 'customers created from Hamnivo');
  }

  async createCheckout(): Promise<{ url: string; ref: string }> {
    throw unsupported('WHMCS', 'checkout from Hamnivo');
  }

  async createPortal(): Promise<{ url: string }> {
    if (!this.options.clientAreaUrl) throw unsupported('WHMCS', 'a client area link');
    return { url: this.options.clientAreaUrl };
  }

  async listInvoices(): Promise<ProviderInvoice[]> {
    return [];
  }

  async getSubscription(): Promise<ProviderSubscription | null> {
    return null;
  }

  verifyWebhook(): BillingEvent {
    throw new BillingWebhookSignatureError('mismatch');
  }
}
