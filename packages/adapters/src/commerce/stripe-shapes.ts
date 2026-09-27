import type {
  CheckoutSession,
  NormalizedEvent,
  NormalizedEventType,
  ProviderRefund,
} from './port.js';

/**
 * Stripe objects (API version 2026-08-26.dahlia) reduced to the port's types. Only the fields
 * Hamnivo acts on are read; customer details, addresses and payment method data are ignored, so
 * they never reach Hamnivo's records, logs or any model (C05).
 */

export const STRIPE_API_VERSION = '2026-08-26.dahlia';

/** The Stripe-side fields a checkout session maps from. */
export interface StripeSessionLike {
  id: string;
  url?: string | null;
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: string | { id: string } | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  created: number;
  expires_at: number;
}

export interface StripeRefundLike {
  id: string;
  status?: string | null;
  amount: number;
  currency: string;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  failure_reason?: string | null;
  created: number;
}

export interface StripeEventLike {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  account?: string | null;
  data: { object: Record<string, unknown> };
}

const refOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

export function mapStripeSession(session: StripeSessionLike): CheckoutSession {
  const status =
    session.status === 'complete' || session.status === 'expired' ? session.status : 'open';
  const paymentStatus =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
      ? session.payment_status
      : 'unpaid';
  const metadata = { ...(session.metadata ?? {}) };
  return {
    id: session.id,
    url: status === 'open' ? (session.url ?? null) : null,
    status,
    paymentStatus,
    paymentRef: refOf(session.payment_intent),
    amountTotalMinor: session.amount_total == null ? null : BigInt(session.amount_total),
    currency: session.currency ? session.currency.toUpperCase() : null,
    reference: session.client_reference_id ?? metadata.hv_reference ?? null,
    metadata,
    createdAt: new Date(session.created * 1000),
    expiresAt: new Date(session.expires_at * 1000),
  };
}

export function mapStripeRefund(refund: StripeRefundLike): ProviderRefund {
  const known = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'] as const;
  const status = (known as readonly string[]).includes(refund.status ?? '')
    ? (refund.status as ProviderRefund['status'])
    : 'pending';
  return {
    id: refund.id,
    status,
    amountMinor: BigInt(refund.amount),
    currency: refund.currency.toUpperCase(),
    paymentRef: refOf(refund.payment_intent),
    reference: refund.metadata?.hv_reference ?? null,
    failureReason: refund.failure_reason ?? null,
    createdAt: new Date(refund.created * 1000),
  };
}

const EVENT_TYPES: Record<string, NormalizedEventType> = {
  'checkout.session.completed': 'checkout.completed',
  'checkout.session.async_payment_succeeded': 'checkout.async_succeeded',
  'checkout.session.async_payment_failed': 'checkout.async_failed',
  'checkout.session.expired': 'checkout.expired',
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.processing': 'payment.processing',
  'payment_intent.requires_action': 'payment.requires_action',
  'refund.created': 'refund.updated',
  'refund.updated': 'refund.updated',
  'refund.failed': 'refund.updated',
  'charge.refund.updated': 'refund.updated',
};

export function mapStripeEvent(event: StripeEventLike): NormalizedEvent {
  const type = EVENT_TYPES[event.type] ?? 'ignored';
  const object = event.data.object;
  const base: NormalizedEvent = {
    id: event.id,
    type,
    providerType: event.type,
    occurredAt: new Date(event.created * 1000),
    account: event.account ?? null,
    livemode: event.livemode,
  };
  if (type.startsWith('checkout.')) {
    const checkout = mapStripeSession(object as unknown as StripeSessionLike);
    return { ...base, checkout, paymentRef: checkout.paymentRef, reference: checkout.reference };
  }
  if (type.startsWith('payment.')) {
    const metadata = (object.metadata ?? {}) as Record<string, string>;
    return {
      ...base,
      paymentRef: typeof object.id === 'string' ? object.id : null,
      reference: metadata.hv_reference ?? null,
    };
  }
  if (type === 'refund.updated') {
    const refund = mapStripeRefund(object as unknown as StripeRefundLike);
    return { ...base, refund, paymentRef: refund.paymentRef, reference: refund.reference };
  }
  return base;
}
