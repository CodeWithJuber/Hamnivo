import type {
  BillingEvent,
  ProviderInvoice,
  ProviderSubscription,
  SubscriptionState,
} from './port.js';

/**
 * Stripe Billing objects (API version 2026-09-30.endive, the version stripe@23 is built for)
 * reduced to the port's types. Since 2025-03-31 the billing period lives on the subscription
 * items and an invoice names its subscription under `parent.subscription_details`. Only fields
 * billing acts on are read: no card, address or customer details reach Hamnivo.
 */

export const BILLING_STRIPE_API_VERSION = '2026-09-30.endive';

type Ref = string | { id: string } | null | undefined;

export interface StripeSubscriptionLike {
  id: string;
  customer?: Ref;
  status: string;
  cancel_at_period_end?: boolean | null;
  trial_end?: number | null;
  metadata?: Record<string, string> | null;
  items?: {
    data: { price?: { id: string } | null; current_period_end?: number | null }[];
  } | null;
}

export interface StripeInvoiceLike {
  id: string;
  number?: string | null;
  status?: string | null;
  currency: string;
  total?: number | null;
  amount_paid?: number | null;
  created: number;
  status_transitions?: { paid_at?: number | null } | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  customer?: Ref;
  parent?: {
    subscription_details?: {
      subscription?: Ref;
      metadata?: Record<string, string> | null;
    } | null;
  } | null;
  attempt_count?: number | null;
  next_payment_attempt?: number | null;
}

export interface StripeCheckoutSessionLike {
  id: string;
  mode?: string | null;
  client_reference_id?: string | null;
  customer?: Ref;
  subscription?: Ref;
  metadata?: Record<string, string> | null;
}

export interface StripeEventLike {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export const refOf = (value: Ref): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

const dateOf = (seconds: number | null | undefined): Date | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : null;

const STATES: Record<string, SubscriptionState> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete_expired: 'canceled',
  incomplete: 'incomplete',
  paused: 'paused',
};

/** A status Stripe adds later reads as `incomplete`: it neither grants nor removes a plan. */
export function subscriptionState(status: string): SubscriptionState {
  return STATES[status] ?? 'incomplete';
}

export function mapStripeSubscription(subscription: StripeSubscriptionLike): ProviderSubscription {
  const items = subscription.items?.data ?? [];
  const ends = items
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');
  const metadata = subscription.metadata ?? {};
  return {
    ref: subscription.id,
    customerRef: refOf(subscription.customer),
    state: subscriptionState(subscription.status),
    priceRef: items[0]?.price?.id ?? null,
    tenantRef: metadata.hv_tenant ?? null,
    planKey: metadata.hv_plan ?? null,
    currentPeriodEnd: ends.length > 0 ? new Date(Math.min(...ends) * 1000) : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    trialEnd: dateOf(subscription.trial_end),
  };
}

const INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'void', 'uncollectible']);

export function mapStripeInvoice(invoice: StripeInvoiceLike): ProviderInvoice {
  const details = invoice.parent?.subscription_details ?? null;
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: INVOICE_STATUSES.has(invoice.status ?? '')
      ? (invoice.status as ProviderInvoice['status'])
      : 'open',
    currency: invoice.currency.toUpperCase(),
    totalMinor: BigInt(invoice.total ?? 0),
    amountPaidMinor: BigInt(invoice.amount_paid ?? 0),
    createdAt: new Date(invoice.created * 1000),
    paidAt: dateOf(invoice.status_transitions?.paid_at),
    url: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
    customerRef: refOf(invoice.customer),
    subscriptionRef: refOf(details?.subscription),
    tenantRef: details?.metadata?.hv_tenant ?? null,
    attemptCount: invoice.attempt_count ?? 0,
    nextAttemptAt: dateOf(invoice.next_payment_attempt),
  };
}

const SUBSCRIPTION_CHANGES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

export function mapStripeBillingEvent(event: StripeEventLike): BillingEvent {
  const base = {
    id: event.id,
    providerType: event.type,
    occurredAt: new Date(event.created * 1000),
    livemode: event.livemode,
  };
  const object = event.data.object;
  if (SUBSCRIPTION_CHANGES.has(event.type)) {
    return {
      ...base,
      kind: 'subscription.changed',
      subscription: mapStripeSubscription(object as unknown as StripeSubscriptionLike),
    };
  }
  switch (event.type) {
    case 'customer.subscription.deleted':
      return {
        ...base,
        kind: 'subscription.deleted',
        subscription: mapStripeSubscription(object as unknown as StripeSubscriptionLike),
      };
    // Stripe also sends invoice.payment_succeeded for the same payment; one receipt is enough.
    case 'invoice.paid':
      return {
        ...base,
        kind: 'invoice.paid',
        invoice: mapStripeInvoice(object as unknown as StripeInvoiceLike),
      };
    case 'invoice.payment_failed':
      return {
        ...base,
        kind: 'invoice.payment_failed',
        invoice: mapStripeInvoice(object as unknown as StripeInvoiceLike),
      };
    case 'checkout.session.completed': {
      const session = object as unknown as StripeCheckoutSessionLike;
      if (session.mode && session.mode !== 'subscription') return { ...base, kind: 'ignored' };
      return {
        ...base,
        kind: 'checkout.completed',
        tenantRef: session.metadata?.hv_tenant ?? session.client_reference_id ?? null,
        customerRef: refOf(session.customer),
        subscriptionRef: refOf(session.subscription),
      };
    }
    default:
      return { ...base, kind: 'ignored' };
  }
}
