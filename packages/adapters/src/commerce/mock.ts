import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CommerceCapabilities } from '@hamnivo/domain/commerce';
import { CommerceProviderError, QuoteRejectedError, WebhookSignatureError } from './errors.js';
import type {
  CatalogResult,
  CheckoutRequest,
  CheckoutSession,
  CommerceProvider,
  NormalizedEvent,
  ProviderQuote,
  ProviderRefund,
  QuoteRequest,
  RefundRequest,
} from './port.js';
import {
  mapStripeEvent,
  mapStripeRefund,
  mapStripeSession,
  type StripeEventLike,
  type StripeRefundLike,
  type StripeSessionLike,
} from './stripe-shapes.js';

/**
 * `mock`: an in-memory merchant and payment provider for development, demos and tests. It keeps
 * a small catalog, hosted checkout sessions, payments and refunds, emits Stripe-shaped events
 * signed like Stripe's, honours idempotency keys for a retention window, and can be told to fail
 * a call before or after applying it. It never touches the network and never sees a card.
 */

export interface MockProduct {
  id: string;
  variantId: string | null;
  name: string;
  description: string | null;
  priceMinor: bigint;
  currency: string;
  stock: number | null;
  active: boolean;
}

export type MockOperation =
  | 'searchCatalog'
  | 'quote'
  | 'createCheckout'
  | 'getCheckout'
  | 'findCheckout'
  | 'expireCheckout'
  | 'createRefund'
  | 'getRefund'
  | 'findRefund';

/**
 * `timeout_before`: the request never arrived. `timeout_after`: it was applied, then the answer
 * was lost. `unavailable`: a server error before applying. `reject`: a plain refusal (4xx).
 */
export type MockFault = 'timeout_before' | 'timeout_after' | 'unavailable' | 'reject';

interface MockSession extends StripeSessionLike {
  object: 'checkout.session';
  livemode: false;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
}

interface MockRefund extends StripeRefundLike {
  object: 'refund';
  reason: string;
  metadata: Record<string, string>;
}

interface MockPayment {
  id: string;
  sessionId: string;
  amountMinor: bigint;
  refundedMinor: bigint;
  currency: string;
  metadata: Record<string, string>;
}

/** The demo store from the design boards (Northline): prices in AED. */
export function demoProducts(): MockProduct[] {
  return [
    {
      id: 'prod_notebook',
      variantId: null,
      name: 'Everyday Notebook',
      description: 'Lined pages, A5, 160 pages',
      priceMinor: 3500n,
      currency: 'AED',
      stock: 25,
      active: true,
    },
    {
      id: 'prod_pens',
      variantId: null,
      name: 'Black Pen Set',
      description: 'Set of 2 ballpoint pens',
      priceMinor: 1500n,
      currency: 'AED',
      stock: 40,
      active: true,
    },
    {
      id: 'prod_planner',
      variantId: null,
      name: 'Weekly Planner',
      description: 'Undated, 52 weeks',
      priceMinor: 4500n,
      currency: 'AED',
      stock: 0,
      active: true,
    },
  ];
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export class MockCommerceStore {
  private static readonly stores = new Map<string, MockCommerceStore>();

  /** The store with this id, created with the demo catalog on first use. */
  static get(id: string): MockCommerceStore {
    let store = MockCommerceStore.stores.get(id);
    if (!store) {
      store = new MockCommerceStore(id);
      MockCommerceStore.stores.set(id, store);
    }
    return store;
  }

  static reset(id: string): void {
    MockCommerceStore.stores.delete(id);
  }

  readonly accountId: string;
  readonly products = new Map<string, MockProduct>();
  shipping: { amountMinor: bigint; label: string } | null = {
    amountMinor: 1000n,
    label: 'Delivery',
  };
  currencies = ['AED', 'USD', 'SAR', 'PKR', 'INR'];
  refundMode: 'pending' | 'succeeded' = 'pending';
  /** How long the provider remembers an idempotency key (Stripe: at least 24 hours). */
  idempotencyWindowMs = 24 * 60 * 60 * 1000;
  clock: () => Date = () => new Date();

  readonly sessions = new Map<string, MockSession>();
  readonly refunds = new Map<string, MockRefund>();
  readonly payments = new Map<string, MockPayment>();
  readonly events: StripeEventLike[] = [];
  readonly calls: { op: MockOperation; at: Date }[] = [];
  private readonly idempotency = new Map<
    string,
    { at: number; fingerprint: string; result: unknown }
  >();
  private readonly faults: { op: MockOperation; mode: MockFault }[] = [];
  private counter = 0;

  private constructor(readonly id: string) {
    this.accountId = `acct_mock_${id.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'store'}`;
    for (const product of demoProducts()) this.products.set(product.id, product);
  }

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_mock_${this.counter.toString(36)}${randomBytes(6).toString('hex')}`;
  }

  /** The next call of `op` fails this way (faults queue up in order). */
  inject(op: MockOperation, mode: MockFault): void {
    this.faults.push({ op, mode });
  }

  setPrice(productId: string, priceMinor: bigint): void {
    const product = this.products.get(productId);
    if (!product) throw new Error(`No product ${productId}`);
    product.priceMinor = priceMinor;
  }

  /** Payments the customer actually made (paid sessions). */
  get charges(): number {
    return [...this.payments.values()].length;
  }

  countCalls(op: MockOperation): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /** Runs one provider call with any injected fault. */
  async run<T>(op: MockOperation, apply: () => T): Promise<T> {
    this.calls.push({ op, at: this.clock() });
    const index = this.faults.findIndex((f) => f.op === op);
    const fault = index >= 0 ? this.faults.splice(index, 1)[0]?.mode : undefined;
    const timeout = () =>
      new CommerceProviderError('timeout', 'Mock provider did not answer in time', {
        retryable: true,
        mayHaveApplied: true,
      });
    switch (fault) {
      case 'timeout_before':
        throw timeout();
      case 'unavailable':
        throw new CommerceProviderError('unavailable', 'Mock provider error', {
          retryable: true,
          mayHaveApplied: true,
          status: 500,
        });
      case 'reject':
        throw new CommerceProviderError('invalid_request', 'Mock provider refused', {
          retryable: false,
          mayHaveApplied: false,
          status: 400,
        });
      case 'timeout_after':
        apply();
        throw timeout();
      default:
        return apply();
    }
  }

  /** Replays the first answer for a key inside the retention window (Stripe semantics). */
  idempotent<T>(key: string, fingerprint: string, create: () => T): T {
    const now = this.clock().getTime();
    const seen = this.idempotency.get(key);
    if (seen && now - seen.at < this.idempotencyWindowMs) {
      if (seen.fingerprint !== fingerprint) {
        throw new CommerceProviderError(
          'idempotency_conflict',
          'Key reused with other parameters',
          {
            retryable: false,
            mayHaveApplied: false,
            status: 400,
          },
        );
      }
      return seen.result as T;
    }
    const result = create();
    this.idempotency.set(key, { at: now, fingerprint, result });
    return result;
  }

  private emit(type: string, object: Record<string, unknown>): StripeEventLike {
    const event: StripeEventLike = {
      id: this.nextId('evt'),
      type,
      created: seconds(this.clock()),
      livemode: false,
      account: this.accountId,
      data: { object: structuredClone(object) },
    };
    this.events.push(event);
    return event;
  }

  createSession(request: CheckoutRequest): MockSession {
    const id = this.nextId('cs');
    const session: MockSession = {
      id,
      object: 'checkout.session',
      livemode: false,
      url: `https://checkout.mock.hamnivo.test/pay/${id}`,
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: Number(request.quote.totalMinor),
      currency: request.quote.currency.toLowerCase(),
      client_reference_id: request.reference,
      metadata: { ...request.metadata, hv_reference: request.reference },
      created: seconds(this.clock()),
      expires_at: seconds(request.expiresAt),
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    };
    this.sessions.set(id, session);
    return session;
  }

  private session(id: string): MockSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new CommerceProviderError('not_found', 'No such checkout session', {
        retryable: false,
        mayHaveApplied: false,
        status: 404,
        code: 'resource_missing',
      });
    }
    return session;
  }

  /**
   * The customer pays on the hosted page. `async` models a bank payment that settles later.
   * Returns the events the provider sends.
   */
  pay(sessionId: string, options: { async?: boolean } = {}): StripeEventLike[] {
    const session = this.session(sessionId);
    if (session.status !== 'open') throw new Error(`Session ${sessionId} is ${session.status}`);
    if (seconds(this.clock()) >= session.expires_at)
      throw new Error(`Session ${sessionId} expired`);
    const paymentId = this.nextId('pi');
    session.status = 'complete';
    session.payment_intent = paymentId;
    session.payment_status = options.async ? 'unpaid' : 'paid';
    const events = [this.emit('checkout.session.completed', { ...session })];
    if (!options.async) events.push(this.capture(session, paymentId));
    return events;
  }

  private capture(session: MockSession, paymentId: string): StripeEventLike {
    session.payment_status = 'paid';
    this.payments.set(paymentId, {
      id: paymentId,
      sessionId: session.id,
      amountMinor: BigInt(session.amount_total ?? 0),
      refundedMinor: 0n,
      currency: session.currency ?? 'aed',
      metadata: session.metadata,
    });
    return this.emit('payment_intent.succeeded', {
      id: paymentId,
      object: 'payment_intent',
      amount: session.amount_total,
      currency: session.currency,
      status: 'succeeded',
      metadata: session.metadata,
    });
  }

  /** Settles an asynchronous payment started with `pay(…, { async: true })`. */
  settleAsync(sessionId: string, outcome: 'succeeded' | 'failed'): StripeEventLike[] {
    const session = this.session(sessionId);
    const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : '';
    if (outcome === 'failed') {
      return [this.emit('checkout.session.async_payment_failed', { ...session })];
    }
    const captured = this.capture(session, paymentId);
    return [this.emit('checkout.session.async_payment_succeeded', { ...session }), captured];
  }

  /** The hosted page times out without payment. */
  expireSession(sessionId: string): StripeEventLike {
    const session = this.session(sessionId);
    if (session.status !== 'open') throw new Error(`Session ${sessionId} is ${session.status}`);
    session.status = 'expired';
    session.url = null;
    return this.emit('checkout.session.expired', { ...session });
  }

  createRefund(request: RefundRequest): MockRefund {
    const payment = this.payments.get(request.paymentRef);
    if (!payment) {
      throw new CommerceProviderError('invalid_request', 'No such payment', {
        retryable: false,
        mayHaveApplied: false,
        status: 400,
        code: 'resource_missing',
      });
    }
    if (payment.refundedMinor + request.amountMinor > payment.amountMinor) {
      throw new CommerceProviderError('invalid_request', 'Refund exceeds the charge', {
        retryable: false,
        mayHaveApplied: false,
        status: 400,
        code: 'charge_already_refunded',
      });
    }
    payment.refundedMinor += request.amountMinor;
    const refund: MockRefund = {
      id: this.nextId('re'),
      object: 'refund',
      status: this.refundMode,
      amount: Number(request.amountMinor),
      currency: request.currency.toLowerCase(),
      payment_intent: request.paymentRef,
      metadata: { ...request.metadata, hv_reference: request.reference },
      failure_reason: null,
      reason: request.reason,
      created: seconds(this.clock()),
    };
    this.refunds.set(refund.id, refund);
    this.emit('refund.created', { ...refund });
    return refund;
  }

  /** The provider finishes a pending refund. */
  settleRefund(refundId: string, outcome: 'succeeded' | 'failed'): StripeEventLike {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`No refund ${refundId}`);
    refund.status = outcome;
    if (outcome === 'failed') {
      refund.failure_reason = 'expired_or_canceled_card';
      const payment = this.payments.get(String(refund.payment_intent));
      if (payment) payment.refundedMinor -= BigInt(refund.amount);
    }
    return this.emit(outcome === 'failed' ? 'refund.failed' : 'refund.updated', { ...refund });
  }

  /** The exact body and headers the provider would POST for an event. */
  signed(
    event: StripeEventLike,
    secret: string,
    at: Date = this.clock(),
  ): { rawBody: Buffer; headers: Record<string, string> } {
    const payload = JSON.stringify(event);
    const timestamp = seconds(at);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return {
      rawBody: Buffer.from(payload, 'utf8'),
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
    };
  }
}

/** Parses and checks a Stripe-style `t=…,v1=…` signature over the exact raw body. */
export function verifyStripeStyleSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: Date,
  toleranceSeconds = 300,
): void {
  if (!header) throw new WebhookSignatureError('missing');
  const parts = new Map<string, string[]>();
  for (const item of header.split(',')) {
    const [key, value] = item.split('=');
    if (!key || !value) throw new WebhookSignatureError('malformed');
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const timestamp = Number(parts.get('t')?.[0]);
  const signatures = parts.get('v1') ?? [];
  if (!Number.isInteger(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError('malformed');
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const matches = signatures.some((candidate) => {
    const bytes = Buffer.from(candidate, 'hex');
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!matches) throw new WebhookSignatureError('mismatch');
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError('stale');
  }
}

export class MockCommerceProvider implements CommerceProvider {
  readonly kind = 'mock' as const;

  constructor(readonly store: MockCommerceStore) {}

  capabilities(): CommerceCapabilities {
    return {
      version: 1,
      provider: 'mock',
      apiVersion: 'mock-1',
      catalog: { search: true, variants: false, stock: true },
      checkout: { hosted: true, authorizationOnly: false },
      refunds: { full: true, partial: true },
      cancellation: false,
      recurring: false,
      provisioning: false,
      currencies: [...this.store.currencies],
      countries: [],
      tax: 'included',
    };
  }

  searchCatalog(query: { text?: string; limit: number }): Promise<CatalogResult> {
    return this.store.run('searchCatalog', () => {
      const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = [...this.store.products.values()]
        .filter((p) => p.active)
        .filter((p) => {
          const text = `${p.name} ${p.description ?? ''}`.toLowerCase();
          return words.length === 0 || words.some((w) => text.includes(w));
        })
        .slice(0, query.limit)
        .map((p) => ({
          productId: p.id,
          variantId: p.variantId,
          name: p.name,
          description: p.description,
          unitPriceMinor: p.priceMinor,
          currency: p.currency,
          availability:
            p.stock === null
              ? ('unknown' as const)
              : p.stock > 0
                ? ('in_stock' as const)
                : ('out_of_stock' as const),
          stockQuantity: p.stock,
          recurring: null,
          imageUrl: null,
        }));
      return { items, observedAt: this.store.clock(), source: 'mock:catalog' };
    });
  }

  quote(request: QuoteRequest): Promise<ProviderQuote> {
    return this.store.run('quote', () => {
      const currency = request.currency.toUpperCase();
      if (!this.store.currencies.includes(currency)) {
        throw new QuoteRejectedError('currency_not_supported');
      }
      const lines = request.lines.map((line) => {
        const product = this.store.products.get(line.productId);
        if (!product) throw new QuoteRejectedError('unknown_product', line.productId);
        if (!product.active) throw new QuoteRejectedError('inactive_product', line.productId);
        if (product.currency !== currency) {
          throw new QuoteRejectedError('currency_mismatch', line.productId);
        }
        if (product.stock !== null && product.stock < line.quantity) {
          throw new QuoteRejectedError('out_of_stock', line.productId);
        }
        return {
          productId: product.id,
          variantId: product.variantId,
          name: product.name,
          quantity: line.quantity,
          unitPriceMinor: product.priceMinor,
          totalMinor: product.priceMinor * BigInt(line.quantity),
        };
      });
      const subtotal = lines.reduce((acc, l) => acc + l.totalMinor, 0n);
      const shipping = this.store.shipping?.amountMinor ?? null;
      const now = this.store.clock();
      return {
        currency,
        lines,
        subtotalMinor: subtotal,
        discountMinor: 0n,
        taxMinor: null,
        taxMode: 'included' as const,
        shippingMinor: shipping,
        totalMinor: subtotal + (shipping ?? 0n),
        recurring: null,
        validUntil: new Date(now.getTime() + 60 * 60 * 1000),
        observedAt: now,
      };
    });
  }

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    return this.store.run('createCheckout', () => {
      const fingerprint = JSON.stringify({
        reference: request.reference,
        total: request.quote.totalMinor.toString(),
        currency: request.quote.currency,
      });
      const session = this.store.idempotent(request.idempotencyKey, fingerprint, () =>
        this.store.createSession(request),
      );
      return mapStripeSession(session);
    });
  }

  getCheckout(sessionId: string): Promise<CheckoutSession> {
    return this.store.run('getCheckout', () => {
      const session = this.store.sessions.get(sessionId);
      if (!session) {
        throw new CommerceProviderError('not_found', 'No such checkout session', {
          retryable: false,
          mayHaveApplied: false,
          status: 404,
        });
      }
      this.expireIfDue(session);
      return mapStripeSession(session);
    });
  }

  private expireIfDue(session: MockSession) {
    if (session.status === 'open' && seconds(this.store.clock()) >= session.expires_at) {
      this.store.expireSession(session.id);
    }
  }

  findCheckout(reference: string, createdAfter: Date): Promise<CheckoutSession | null> {
    return this.store.run('findCheckout', () => {
      const since = seconds(createdAfter) - 60;
      const match = [...this.store.sessions.values()].find(
        (s) => s.created >= since && s.client_reference_id === reference,
      );
      if (match) this.expireIfDue(match);
      return match ? mapStripeSession(match) : null;
    });
  }

  expireCheckout(sessionId: string): Promise<CheckoutSession> {
    return this.store.run('expireCheckout', () => {
      const session = this.store.sessions.get(sessionId);
      if (!session) {
        throw new CommerceProviderError('not_found', 'No such checkout session', {
          retryable: false,
          mayHaveApplied: false,
          status: 404,
        });
      }
      if (session.status === 'open') this.store.expireSession(sessionId);
      return mapStripeSession(session);
    });
  }

  createRefund(request: RefundRequest): Promise<ProviderRefund> {
    return this.store.run('createRefund', () => {
      const fingerprint = JSON.stringify({
        payment: request.paymentRef,
        amount: request.amountMinor.toString(),
      });
      const refund = this.store.idempotent(request.idempotencyKey, fingerprint, () =>
        this.store.createRefund(request),
      );
      return mapStripeRefund(refund);
    });
  }

  getRefund(refundId: string): Promise<ProviderRefund> {
    return this.store.run('getRefund', () => {
      const refund = this.store.refunds.get(refundId);
      if (!refund) {
        throw new CommerceProviderError('not_found', 'No such refund', {
          retryable: false,
          mayHaveApplied: false,
          status: 404,
        });
      }
      return mapStripeRefund(refund);
    });
  }

  findRefund(reference: string, paymentRef: string): Promise<ProviderRefund | null> {
    return this.store.run('findRefund', () => {
      const match = [...this.store.refunds.values()].find(
        (r) => r.payment_intent === paymentRef && r.metadata.hv_reference === reference,
      );
      return match ? mapStripeRefund(match) : null;
    });
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
    now: Date = this.store.clock(),
  ): NormalizedEvent {
    const header = headers['stripe-signature'];
    verifyStripeStyleSignature(rawBody, Array.isArray(header) ? header[0] : header, secret, now);
    let event: StripeEventLike;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as StripeEventLike;
    } catch {
      throw new WebhookSignatureError('malformed');
    }
    return mapStripeEvent(event);
  }
}
