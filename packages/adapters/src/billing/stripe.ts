import Stripe from 'stripe';
import {
  type BillingCapabilities,
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookSignatureError,
  type CheckoutRequest,
  type CustomerRequest,
  type PortalRequest,
  type ProviderInvoice,
  type ProviderSubscription,
} from './port.js';
import {
  BILLING_STRIPE_API_VERSION,
  mapStripeBillingEvent,
  mapStripeInvoice,
  mapStripeSubscription,
  type StripeEventLike,
  type StripeInvoiceLike,
  type StripeSubscriptionLike,
} from './stripe-shapes.js';

export interface StripeBillingOptions {
  /** Secret or restricted key of the operator's Stripe account (from the environment). */
  apiKey: string;
  timeoutMs?: number;
  /** Another API origin, such as stripe-mock or the fake server in tests. Never in production. */
  apiBase?: string | null;
  /** Seconds a webhook timestamp may differ from now (Stripe's default is 300). */
  webhookToleranceSeconds?: number;
}

/** Maps a Stripe SDK error to whether repeating the call (with the same key) may help. */
export function billingStripeError(error: unknown): BillingProviderError {
  const e = error as { type?: string; statusCode?: number; code?: string; message?: string };
  const code = e.code ?? null;
  switch (e.type) {
    case 'StripeConnectionError': {
      const timeout = /timeout|timed out/i.test(e.message ?? '');
      return new BillingProviderError(
        timeout ? 'timeout' : 'network',
        timeout ? 'Stripe did not answer in time' : 'Stripe could not be reached',
        true,
        code,
      );
    }
    case 'StripeAPIError':
      return new BillingProviderError('unavailable', 'Stripe reported a server error', true, code);
    case 'StripeRateLimitError':
      return new BillingProviderError('rate_limited', 'Stripe rate limit reached', true, code);
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return new BillingProviderError('auth', 'Stripe refused the credentials', false, code);
    case 'StripeInvalidRequestError':
      return new BillingProviderError(
        e.statusCode === 404 || code === 'resource_missing' ? 'not_found' : 'invalid_request',
        'Stripe refused the request',
        false,
        code,
      );
    default:
      return new BillingProviderError('unknown', 'Stripe call failed', false, code);
  }
}

/**
 * Stripe Billing as the server's billing provider: one customer per workspace, hosted Checkout
 * Sessions in subscription mode (the card never touches Hamnivo), the Customer Portal, and signed
 * webhooks verified by the SDK over the exact raw body. Writes carry idempotency keys, so the
 * SDK's own retries cannot create a second customer or subscription.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeBillingOptions) {
    const base = options.apiBase ? new URL(options.apiBase) : null;
    this.stripe = new Stripe(options.apiKey, {
      apiVersion: BILLING_STRIPE_API_VERSION as Stripe.StripeConfig['apiVersion'],
      maxNetworkRetries: 2,
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

  capabilities(): BillingCapabilities {
    return { checkout: true, portal: true, invoices: true, webhooks: true };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      throw billingStripeError(error);
    }
  }

  async createCustomer(request: CustomerRequest): Promise<{ customerRef: string }> {
    const customer = await this.call(() =>
      this.stripe.customers.create(
        {
          name: request.name,
          ...(request.email ? { email: request.email } : {}),
          metadata: { hv_tenant: request.tenantRef },
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    return { customerRef: customer.id };
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; ref: string }> {
    const metadata = { hv_tenant: request.tenantRef, hv_plan: request.planKey };
    const session = await this.call(() =>
      this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: request.customerRef,
          client_reference_id: request.tenantRef,
          line_items: [{ price: request.priceRef, quantity: 1 }],
          // The subscription carries the workspace, so every later event names it.
          subscription_data: {
            metadata,
            ...(request.trialDays > 0 ? { trial_period_days: request.trialDays } : {}),
          },
          metadata,
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          allow_promotion_codes: true,
        },
        { idempotencyKey: request.idempotencyKey },
      ),
    );
    if (!session.url) {
      throw new BillingProviderError('unknown', 'Stripe returned no checkout page', false);
    }
    return { url: session.url, ref: session.id };
  }

  async createPortal(request: PortalRequest): Promise<{ url: string }> {
    const session = await this.call(() =>
      this.stripe.billingPortal.sessions.create({
        customer: request.customerRef,
        return_url: request.returnUrl,
      }),
    );
    return { url: session.url };
  }

  async listInvoices(customerRef: string, limit: number): Promise<ProviderInvoice[]> {
    const list = await this.call(() =>
      this.stripe.invoices.list({
        customer: customerRef,
        limit: Math.min(Math.max(limit, 1), 100),
      }),
    );
    return list.data
      .filter((invoice) => invoice.status !== 'draft')
      .map((invoice) => mapStripeInvoice(invoice as unknown as StripeInvoiceLike));
  }

  async getSubscription(ref: string): Promise<ProviderSubscription | null> {
    try {
      const subscription = await this.call(() => this.stripe.subscriptions.retrieve(ref));
      return mapStripeSubscription(subscription as unknown as StripeSubscriptionLike);
    } catch (error) {
      if (error instanceof BillingProviderError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
    now: Date = new Date(),
  ): BillingEvent {
    const header = headers['stripe-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) throw new BillingWebhookSignatureError('missing');
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
      if (/tolerance/i.test(message)) throw new BillingWebhookSignatureError('stale');
      if (/unable to extract|expected scheme/i.test(message)) {
        throw new BillingWebhookSignatureError('malformed');
      }
      throw new BillingWebhookSignatureError('mismatch');
    }
    return mapStripeBillingEvent(event);
  }
}
