import { type CommerceCapabilities, isCurrencyCode } from '@hamnivo/domain/commerce';
import Stripe from 'stripe';
import { CommerceProviderError, QuoteRejectedError, WebhookSignatureError } from './errors.js';
import type {
  CatalogItem,
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
  STRIPE_API_VERSION,
  type StripeEventLike,
  type StripeRefundLike,
  type StripeSessionLike,
} from './stripe-shapes.js';

export interface StripeProviderOptions {
  /** Secret or restricted key (sk_… / rk_…), revealed by the secret broker just in time. */
  apiKey: string;
  /** Currencies the merchant sells in (ISO 4217). */
  currencies: string[];
  /** Countries the merchant delivers to; empty: not restricted. */
  countries?: string[];
  /** Delivery charge added to every quote, in the quote currency (minor units). */
  shipping?: { amountMinor: bigint; label: string } | null;
  /** Prices include tax, or no tax applies. Stripe Tax is not used. */
  taxMode?: 'included' | 'none';
  /** The Stripe account that must own incoming events (acct_…), when known. */
  accountId?: string | null;
  timeoutMs?: number;
  /**
   * Another API origin, such as stripe-mock or the fake Stripe server in tests
   * (`http://127.0.0.1:12111`). Never set in production.
   */
  apiBase?: string | null;
  /** Seconds a webhook timestamp may differ from now (Stripe's default is 300). */
  webhookToleranceSeconds?: number;
}

/** Currencies whose Stripe representation differs from ISO 4217 minor units: not offered. */
const STRIPE_SPECIAL = new Set(['ISK', 'MGA', 'UGX', 'IQD', 'LYD']);
/** Stripe needs three-decimal amounts to end in 0. */
const STRIPE_THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
/** Stripe needs whole units for these two-decimal currencies. */
const STRIPE_WHOLE_UNITS = new Set(['HUF', 'TWD']);

/** Whether Stripe can charge exactly this many minor units of this currency. */
export function stripeAmountAllowed(currency: string, amountMinor: bigint): boolean {
  if (!isCurrencyCode(currency) || STRIPE_SPECIAL.has(currency)) return false;
  if (STRIPE_THREE_DECIMAL.has(currency)) return amountMinor % 10n === 0n;
  if (STRIPE_WHOLE_UNITS.has(currency)) return amountMinor % 100n === 0n;
  return amountMinor <= BigInt(Number.MAX_SAFE_INTEGER);
}

/** Stripe's recurring interval, shown on the catalog card; recurring checkout is not offered. */
function recurringOf(recurring: {
  interval: string;
  interval_count: number;
}): CatalogItem['recurring'] {
  switch (recurring.interval) {
    case 'day':
    case 'week':
    case 'month':
    case 'year':
      return { interval: recurring.interval, intervalCount: recurring.interval_count };
    default:
      return null;
  }
}

const toNumber = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuoteRejectedError('amount_not_representable');
  }
  return Number(value);
};

/** Maps a Stripe SDK error to what it means for the money (see CommerceProviderError). */
export function stripeError(error: unknown): CommerceProviderError {
  const e = error as { type?: string; statusCode?: number; code?: string; message?: string };
  const status = e.statusCode;
  const code = e.code ?? null;
  switch (e.type) {
    case 'StripeConnectionError': {
      const timeout = /timeout|timed out/i.test(e.message ?? '');
      return new CommerceProviderError(
        timeout ? 'timeout' : 'network',
        timeout ? 'Stripe did not answer in time' : 'Stripe could not be reached',
        { retryable: true, mayHaveApplied: true, code },
      );
    }
    case 'StripeAPIError':
      return new CommerceProviderError('unavailable', 'Stripe reported a server error', {
        retryable: true,
        mayHaveApplied: true,
        ...(status ? { status } : {}),
        code,
      });
    case 'StripeRateLimitError':
      return new CommerceProviderError('rate_limited', 'Stripe rate limit reached', {
        retryable: true,
        mayHaveApplied: false,
        status: 429,
        code,
      });
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return new CommerceProviderError('auth', 'Stripe refused the credentials', {
        retryable: false,
        mayHaveApplied: false,
        ...(status ? { status } : {}),
        code,
      });
    case 'StripeIdempotencyError':
      return new CommerceProviderError(
        'idempotency_conflict',
        'Stripe saw this idempotency key with different parameters',
        { retryable: false, mayHaveApplied: false, ...(status ? { status } : {}), code },
      );
    case 'StripeCardError':
      return new CommerceProviderError('card_declined', 'The card was declined', {
        retryable: false,
        mayHaveApplied: false,
        ...(status ? { status } : {}),
        code,
      });
    case 'StripeInvalidRequestError':
      return new CommerceProviderError(
        status === 404 || code === 'resource_missing' ? 'not_found' : 'invalid_request',
        'Stripe refused the request',
        { retryable: false, mayHaveApplied: false, ...(status ? { status } : {}), code },
      );
    default:
      return new CommerceProviderError('unknown', 'Stripe call failed', {
        retryable: false,
        mayHaveApplied: true,
        code,
      });
  }
}

/**
 * Stripe as a merchant provider: Products and Prices as the catalog, hosted Checkout Sessions for
 * payment (the card never touches Hamnivo, C05), Refunds, and signed webhooks verified with the
 * SDK over the exact raw body (C08). SDK retries are off: the operation ledger decides what is
 * retried, always with the same idempotency key.
 */
export class StripeCommerceProvider implements CommerceProvider {
  readonly kind = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeProviderOptions) {
    const base = options.apiBase ? new URL(options.apiBase) : null;
    this.stripe = new Stripe(options.apiKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.StripeConfig['apiVersion'],
      maxNetworkRetries: 0,
      timeout: options.timeoutMs ?? 10_000,
      telemetry: false,
      appInfo: { name: 'Hamnivo', url: 'https://hamnivo.dev' },
      ...(base
        ? {
            host: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            protocol: base.protocol === 'https:' ? 'https' : 'http',
          }
        : {}),
    });
  }

  capabilities(): CommerceCapabilities {
    return {
      version: 1,
      provider: 'stripe',
      apiVersion: STRIPE_API_VERSION,
      catalog: { search: true, variants: true, stock: false },
      checkout: { hosted: true, authorizationOnly: false },
      refunds: { full: true, partial: true },
      cancellation: false,
      recurring: false,
      provisioning: false,
      currencies: this.options.currencies.filter(
        (c) => isCurrencyCode(c) && !STRIPE_SPECIAL.has(c),
      ),
      countries: this.options.countries ?? [],
      tax: this.options.taxMode ?? 'included',
    };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof QuoteRejectedError || error instanceof CommerceProviderError)
        throw error;
      throw stripeError(error);
    }
  }

  async searchCatalog(query: { text?: string; limit: number }): Promise<CatalogResult> {
    const prices = await this.call(() =>
      this.stripe.prices.list({ active: true, expand: ['data.product'], limit: 100 }),
    );
    const text = query.text?.trim().toLowerCase() ?? '';
    const items: CatalogItem[] = [];
    for (const price of prices.data) {
      const product = price.product;
      if (typeof product === 'string' || !product || ('deleted' in product && product.deleted)) {
        continue;
      }
      if (!product.active || price.unit_amount == null) continue;
      const currency = price.currency.toUpperCase();
      if (!this.capabilities().currencies.includes(currency)) continue;
      const haystack = `${product.name} ${product.description ?? ''}`.toLowerCase();
      if (text && !text.split(/\s+/).some((word) => word && haystack.includes(word))) continue;
      items.push({
        productId: product.id,
        variantId: price.id,
        name: product.name,
        description: product.description ?? null,
        unitPriceMinor: BigInt(price.unit_amount),
        currency,
        // Stripe keeps no stock; we say so instead of implying availability.
        availability: 'unknown',
        stockQuantity: null,
        recurring: price.recurring ? recurringOf(price.recurring) : null,
        imageUrl: product.images?.[0] ?? null,
      });
      if (items.length >= query.limit) break;
    }
    return { items, observedAt: new Date(), source: 'stripe:prices.list' };
  }

  async quote(request: QuoteRequest): Promise<ProviderQuote> {
    const currency = request.currency.toUpperCase();
    if (!this.capabilities().currencies.includes(currency)) {
      throw new QuoteRejectedError('currency_not_supported');
    }
    const lines = [];
    const missing = (productId: string) => (error: unknown) => {
      if (error instanceof CommerceProviderError && error.kind === 'not_found') {
        throw new QuoteRejectedError('unknown_product', productId);
      }
      throw error;
    };
    for (const line of request.lines) {
      const priceId =
        line.variantId ?? (await this.defaultPrice(line.productId).catch(missing(line.productId)));
      const price = await this.call(() =>
        this.stripe.prices.retrieve(priceId, { expand: ['product'] }),
      ).catch(missing(line.productId));
      const product = price.product;
      if (typeof product === 'string' || !product || ('deleted' in product && product.deleted)) {
        throw new QuoteRejectedError('unknown_product', line.productId);
      }
      if (product.id !== line.productId)
        throw new QuoteRejectedError('unknown_product', line.productId);
      if (!price.active || !product.active || price.unit_amount == null) {
        throw new QuoteRejectedError('inactive_product', line.productId);
      }
      if (price.recurring) throw new QuoteRejectedError('recurring_not_supported', line.productId);
      if (price.currency.toUpperCase() !== currency) {
        throw new QuoteRejectedError('currency_mismatch', line.productId);
      }
      const unit = BigInt(price.unit_amount);
      lines.push({
        productId: product.id,
        variantId: price.id,
        name: product.name,
        quantity: line.quantity,
        unitPriceMinor: unit,
        totalMinor: unit * BigInt(line.quantity),
      });
    }
    const subtotal = lines.reduce((acc, l) => acc + l.totalMinor, 0n);
    const shipping = this.options.shipping?.amountMinor ?? null;
    const total = subtotal + (shipping ?? 0n);
    for (const amount of [total, ...lines.map((l) => l.unitPriceMinor)]) {
      if (!stripeAmountAllowed(currency, amount)) {
        throw new QuoteRejectedError('amount_not_representable');
      }
    }
    return {
      currency,
      lines,
      subtotalMinor: subtotal,
      discountMinor: 0n,
      taxMinor: null,
      taxMode: this.options.taxMode ?? 'included',
      shippingMinor: shipping,
      totalMinor: total,
      recurring: null,
      validUntil: null,
      observedAt: new Date(),
    };
  }

  private async defaultPrice(productId: string): Promise<string> {
    const product = await this.call(() => this.stripe.products.retrieve(productId));
    const price = product.default_price;
    if (!price) throw new QuoteRejectedError('unknown_product', productId);
    return typeof price === 'string' ? price : price.id;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const { quote } = request;
    const currency = quote.currency.toLowerCase();
    const metadata = { ...request.metadata, hv_reference: request.reference };
    const session = await this.call(() =>
      this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          // The approved amounts, not whatever the price list says now: the customer pays
          // exactly the quote they approved (C04).
          line_items: quote.lines.map((line) => ({
            quantity: line.quantity,
            price_data: {
              currency,
              unit_amount: toNumber(line.unitPriceMinor),
              product: line.productId,
            },
          })),
          ...(quote.shippingMinor !== null && quote.shippingMinor > 0n
            ? {
                shipping_options: [
                  {
                    shipping_rate_data: {
                      type: 'fixed_amount' as const,
                      display_name: this.options.shipping?.label ?? 'Delivery',
                      fixed_amount: { amount: toNumber(quote.shippingMinor), currency },
                    },
                  },
                ],
              }
            : {}),
          client_reference_id: request.reference,
          metadata,
          payment_intent_data: { metadata },
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          locale: 'auto',
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    const mapped = mapStripeSession(session as unknown as StripeSessionLike);
    if (mapped.amountTotalMinor !== quote.totalMinor) {
      // Never let a customer pay a different (or an unconfirmed) amount than the one approved.
      await this.expireCheckout(mapped.id).catch(() => undefined);
      throw new CommerceProviderError('invalid_request', 'Stripe total differs from the quote', {
        retryable: false,
        mayHaveApplied: false,
        code: 'amount_mismatch',
      });
    }
    return mapped;
  }

  async getCheckout(sessionId: string): Promise<CheckoutSession> {
    const session = await this.call(() => this.stripe.checkout.sessions.retrieve(sessionId));
    return mapStripeSession(session as unknown as StripeSessionLike);
  }

  async findCheckout(reference: string, createdAfter: Date): Promise<CheckoutSession | null> {
    const gte = Math.floor(createdAfter.getTime() / 1000) - 60;
    let startingAfter: string | undefined;
    // Stripe cannot filter sessions by reference, so recent sessions are paged (bounded).
    for (let page = 0; page < 10; page += 1) {
      const list = await this.call(() =>
        this.stripe.checkout.sessions.list({
          created: { gte },
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }),
      );
      const match = list.data.find(
        (s) => s.client_reference_id === reference || s.metadata?.hv_reference === reference,
      );
      if (match) return mapStripeSession(match as unknown as StripeSessionLike);
      if (!list.has_more || list.data.length === 0) return null;
      startingAfter = list.data.at(-1)?.id;
    }
    throw new CommerceProviderError('unavailable', 'Too many sessions to search', {
      retryable: true,
      mayHaveApplied: false,
    });
  }

  async expireCheckout(sessionId: string): Promise<CheckoutSession> {
    try {
      const session = await this.stripe.checkout.sessions.expire(sessionId);
      return mapStripeSession(session as unknown as StripeSessionLike);
    } catch (error) {
      const mapped = stripeError(error);
      // Stripe refuses to expire a session that is no longer open: report its real state.
      if (mapped.kind === 'invalid_request') return this.getCheckout(sessionId);
      throw mapped;
    }
  }

  async createRefund(request: RefundRequest): Promise<ProviderRefund> {
    const refund = await this.call(() =>
      this.stripe.refunds.create(
        {
          payment_intent: request.paymentRef,
          amount: toNumber(request.amountMinor),
          reason: request.reason,
          metadata: { ...request.metadata, hv_reference: request.reference },
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    return mapStripeRefund(refund as unknown as StripeRefundLike);
  }

  async getRefund(refundId: string): Promise<ProviderRefund> {
    const refund = await this.call(() => this.stripe.refunds.retrieve(refundId));
    return mapStripeRefund(refund as unknown as StripeRefundLike);
  }

  async findRefund(reference: string, paymentRef: string): Promise<ProviderRefund | null> {
    const list = await this.call(() =>
      this.stripe.refunds.list({ payment_intent: paymentRef, limit: 100 }),
    );
    const match = list.data.find((r) => r.metadata?.hv_reference === reference);
    return match ? mapStripeRefund(match as unknown as StripeRefundLike) : null;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
    now: Date = new Date(),
  ): NormalizedEvent {
    const header = headers['stripe-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) throw new WebhookSignatureError('missing');
    let event: StripeEventLike;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
        this.options.webhookToleranceSeconds ?? 300,
        undefined,
        now.getTime(),
      ) as unknown as StripeEventLike;
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (/tolerance/i.test(message)) throw new WebhookSignatureError('stale');
      if (/unable to extract|expected scheme/i.test(message)) {
        throw new WebhookSignatureError('malformed');
      }
      throw new WebhookSignatureError('mismatch');
    }
    return mapStripeEvent(event);
  }
}
