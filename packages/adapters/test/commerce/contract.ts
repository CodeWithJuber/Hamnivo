import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CommerceProvider,
  CommerceProviderError,
  type ProviderQuote,
  QuoteRejectedError,
  WebhookSignatureError,
} from '../../src/commerce/index.js';

export interface SignedDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** What a test can make the provider side do: the customer paying, time passing, faults. */
export interface ProviderControl {
  pay(sessionId: string): Promise<SignedDelivery[]>;
  expire(sessionId: string): Promise<SignedDelivery>;
  settleRefund(refundId: string, outcome: 'succeeded' | 'failed'): Promise<SignedDelivery>;
  /** The next `op` call is applied by the provider, but its answer is lost (a timeout). */
  loseAnswer(op: 'createCheckout' | 'createRefund'): void;
  /** The next `op` call never reaches the provider (a timeout before it arrives). */
  dropRequest(op: 'createCheckout' | 'createRefund'): void;
  setPrice(productId: string, amountMinor: bigint): void;
  sessionCount(): number;
  chargeCount(): number;
  sign(event: object, options?: { secret?: string; at?: Date }): SignedDelivery;
  webhookSecret: string;
}

export interface CommerceKit {
  name: string;
  setup(): Promise<{
    provider: CommerceProvider;
    control: ProviderControl;
    close(): Promise<void>;
  }>;
}

const NOTEBOOK = 'prod_notebook';
const PENS = 'prod_pens';

/** Quote request for the board 20 order: one notebook and one pen set. */
function demoRequest() {
  return {
    currency: 'AED',
    lines: [
      { productId: NOTEBOOK, variantId: null, quantity: 1 },
      { productId: PENS, variantId: null, quantity: 1 },
    ],
  };
}

async function variantsOf(provider: CommerceProvider) {
  const catalog = await provider.searchCatalog({ limit: 20 });
  const variant = (productId: string) =>
    catalog.items.find((i) => i.productId === productId)?.variantId ?? null;
  return {
    currency: 'AED',
    lines: [
      { productId: NOTEBOOK, variantId: variant(NOTEBOOK), quantity: 1 },
      { productId: PENS, variantId: variant(PENS), quantity: 1 },
    ],
  };
}

function checkoutRequest(quote: ProviderQuote, reference = `op_${randomUUID()}`) {
  return {
    reference,
    idempotencyKey: `hv:${reference}`,
    quote,
    successUrl: 'https://widget.example/checkout-return.html?result=success',
    cancelUrl: 'https://widget.example/checkout-return.html?result=cancel',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    metadata: { hv_tenant: 'tnt_test', hv_intent: 'pur_test' },
  };
}

/**
 * The behaviour every commerce provider adapter must share. Run against the in-memory mock and
 * against Stripe through the SDK (fake Stripe server), and optionally stripe-mock.
 */
export function describeCommerceContract(kit: CommerceKit) {
  describe(`${kit.name} commerce contract`, () => {
    const withProvider =
      (test: (provider: CommerceProvider, control: ProviderControl) => Promise<void>) =>
      async () => {
        const { provider, control, close } = await kit.setup();
        try {
          await test(provider, control);
        } finally {
          await close();
        }
      };

    it(
      'declares a capability manifest',
      withProvider(async (provider) => {
        const capabilities = provider.capabilities();
        expect(capabilities.version).toBe(1);
        expect(capabilities.checkout.hosted).toBe(true);
        expect(capabilities.currencies).toContain('AED');
        expect(capabilities.refunds.full).toBe(true);
        expect(typeof capabilities.apiVersion).toBe('string');
      }),
    );

    it(
      'reads the catalog with prices in minor units and the time it was read',
      withProvider(async (provider) => {
        const result = await provider.searchCatalog({ text: 'notebook', limit: 10 });
        const notebook = result.items.find((i) => i.productId === NOTEBOOK);
        expect(notebook).toMatchObject({ name: 'Everyday Notebook', currency: 'AED' });
        expect(notebook?.unitPriceMinor).toBe(3500n);
        expect(result.items.every((i) => typeof i.unitPriceMinor === 'bigint')).toBe(true);
        expect(result.observedAt).toBeInstanceOf(Date);
        expect(result.source).toMatch(/\w+:\w+/);
        expect(result.items.find((i) => i.productId === PENS)).toBeUndefined();
      }),
    );

    it(
      'quotes exact lines and totals from the merchant, every time',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        expect(quote.currency).toBe('AED');
        expect(
          quote.lines.map((l) => [l.productId, l.quantity, l.unitPriceMinor, l.totalMinor]),
        ).toEqual([
          [NOTEBOOK, 1, 3500n, 3500n],
          [PENS, 1, 1500n, 1500n],
        ]);
        expect(quote.subtotalMinor).toBe(5000n);
        expect(quote.shippingMinor).toBe(1000n);
        expect(quote.totalMinor).toBe(6000n);
        // A price change shows in the next quote: nothing is served from a cache (K06).
        control.setPrice(NOTEBOOK, 3600n);
        const requote = await provider.quote(await variantsOf(provider));
        expect(requote.totalMinor).toBe(6100n);
      }),
    );

    it(
      'refuses to quote unknown products and unsupported currencies',
      withProvider(async (provider) => {
        await expect(
          provider.quote({
            currency: 'AED',
            lines: [{ productId: 'prod_missing', variantId: null, quantity: 1 }],
          }),
        ).rejects.toBeInstanceOf(QuoteRejectedError);
        await expect(provider.quote({ ...demoRequest(), currency: 'JPY' })).rejects.toMatchObject({
          reason: 'currency_not_supported',
        });
      }),
    );

    it(
      'creates one hosted checkout per idempotency key and finds it by reference',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const request = checkoutRequest(quote);
        const session = await provider.createCheckout(request);
        expect(session.status).toBe('open');
        expect(session.paymentStatus).toBe('unpaid');
        expect(session.url).toMatch(/^https?:\/\//);
        expect(session.amountTotalMinor).toBe(6000n);
        expect(session.currency).toBe('AED');
        expect(session.reference).toBe(request.reference);
        const again = await provider.createCheckout(request);
        expect(again.id).toBe(session.id);
        expect(control.sessionCount()).toBe(1);
        expect(
          (await provider.findCheckout(request.reference, new Date(Date.now() - 60_000)))?.id,
        ).toBe(session.id);
        expect(await provider.findCheckout('op_unknown', new Date(Date.now() - 60_000))).toBeNull();
        expect((await provider.getCheckout(session.id)).status).toBe('open');
      }),
    );

    it(
      'reports payment through signed events verified over the raw body',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const request = checkoutRequest(quote);
        const session = await provider.createCheckout(request);
        const deliveries = await control.pay(session.id);
        const events = deliveries.map((d) =>
          provider.verifyWebhook(d.rawBody, d.headers, control.webhookSecret),
        );
        const completed = events.find((e) => e.type === 'checkout.completed');
        expect(completed?.checkout).toMatchObject({
          id: session.id,
          status: 'complete',
          paymentStatus: 'paid',
          reference: request.reference,
        });
        expect(completed?.paymentRef).toMatch(/^pi_/);
        expect(completed?.id).toMatch(/^evt_/);
        expect(events.map((e) => e.type)).toContain('payment.succeeded');
        const current = await provider.getCheckout(session.id);
        expect(current).toMatchObject({ status: 'complete', paymentStatus: 'paid', url: null });
        expect(control.chargeCount()).toBe(1);
      }),
    );

    it(
      'rejects events that are tampered with, unsigned, signed with another secret or stale',
      withProvider(async (provider, control) => {
        const event = {
          id: 'evt_forged',
          object: 'event',
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: { id: 'cs_forged', created: 1, expires_at: 2 } },
        };
        const good = control.sign(event);
        expect(provider.verifyWebhook(good.rawBody, good.headers, control.webhookSecret).id).toBe(
          'evt_forged',
        );
        const tampered = Buffer.from(
          good.rawBody.toString('utf8').replace('cs_forged', 'cs_other'),
        );
        expect(() => provider.verifyWebhook(tampered, good.headers, control.webhookSecret)).toThrow(
          WebhookSignatureError,
        );
        expect(() => provider.verifyWebhook(good.rawBody, {}, control.webhookSecret)).toThrow(
          WebhookSignatureError,
        );
        const other = control.sign(event, { secret: 'whsec_someone_else' });
        expect(() =>
          provider.verifyWebhook(other.rawBody, other.headers, control.webhookSecret),
        ).toThrow(WebhookSignatureError);
        const stale = control.sign(event, { at: new Date(Date.now() - 3600_000) });
        expect(() =>
          provider.verifyWebhook(stale.rawBody, stale.headers, control.webhookSecret),
        ).toThrow(WebhookSignatureError);
      }),
    );

    it(
      'leaves a timed-out checkout findable and never creates a second one',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const request = checkoutRequest(quote);
        control.loseAnswer('createCheckout');
        const failure = await provider.createCheckout(request).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(CommerceProviderError);
        expect((failure as CommerceProviderError).mayHaveApplied).toBe(true);
        // Resolution without writing: the session exists at the provider.
        const found = await provider.findCheckout(request.reference, new Date(Date.now() - 60_000));
        expect(found?.amountTotalMinor).toBe(6000n);
        // A retry with the same key returns that session; nothing new is created.
        expect((await provider.createCheckout(request)).id).toBe(found?.id);
        expect(control.sessionCount()).toBe(1);
      }),
    );

    it(
      'shows a request that never arrived as not found, so one retry creates exactly one',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const request = checkoutRequest(quote);
        control.dropRequest('createCheckout');
        await expect(provider.createCheckout(request)).rejects.toMatchObject({
          mayHaveApplied: true,
        });
        expect(
          await provider.findCheckout(request.reference, new Date(Date.now() - 60_000)),
        ).toBeNull();
        expect(control.sessionCount()).toBe(0);
        await provider.createCheckout(request);
        await provider.createCheckout(request);
        expect(control.sessionCount()).toBe(1);
      }),
    );

    it(
      'cancels an open checkout safely, and never undoes a completed one',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const open = await provider.createCheckout(checkoutRequest(quote));
        expect((await provider.expireCheckout(open.id)).status).toBe('expired');
        const paid = await provider.createCheckout(checkoutRequest(quote));
        await control.pay(paid.id);
        const attempt = await provider.expireCheckout(paid.id);
        expect(attempt).toMatchObject({ status: 'complete', paymentStatus: 'paid' });
      }),
    );

    it(
      'refunds exactly, idempotently and within the charge, with the outcome from the provider',
      withProvider(async (provider, control) => {
        const quote = await provider.quote(await variantsOf(provider));
        const session = await provider.createCheckout(checkoutRequest(quote));
        const [completed] = (await control.pay(session.id)).map((d) =>
          provider.verifyWebhook(d.rawBody, d.headers, control.webhookSecret),
        );
        const paymentRef = completed?.paymentRef as string;
        const reference = `op_${randomUUID()}`;
        const request = {
          reference,
          idempotencyKey: `hv:${reference}`,
          paymentRef,
          amountMinor: 1500n,
          currency: 'AED',
          reason: 'requested_by_customer' as const,
          metadata: { hv_refund: 'rfd_test' },
        };
        const refund = await provider.createRefund(request);
        expect(refund).toMatchObject({
          amountMinor: 1500n,
          currency: 'AED',
          paymentRef,
          reference,
        });
        expect(['pending', 'succeeded']).toContain(refund.status);
        expect((await provider.createRefund(request)).id).toBe(refund.id);
        expect((await provider.findRefund(reference, paymentRef))?.id).toBe(refund.id);
        expect(await provider.findRefund('op_other', paymentRef)).toBeNull();
        expect((await provider.getRefund(refund.id)).amountMinor).toBe(1500n);
        const delivery = await control.settleRefund(refund.id, 'succeeded');
        const settled = provider.verifyWebhook(
          delivery.rawBody,
          delivery.headers,
          control.webhookSecret,
        );
        expect(settled.type).toBe('refund.updated');
        expect(settled.refund).toMatchObject({ id: refund.id, status: 'succeeded' });
        // More than the rest of the charge is refused before anything moves.
        const over = await provider
          .createRefund({
            ...request,
            reference: `op_${randomUUID()}`,
            idempotencyKey: `hv:${randomUUID()}`,
            amountMinor: 6000n,
          })
          .catch((e: unknown) => e);
        expect(over).toMatchObject({ kind: 'invalid_request', mayHaveApplied: false });
      }),
    );

    it(
      'reports missing objects as not found, without doubt about side effects',
      withProvider(async (provider) => {
        const failure = await provider.getCheckout('cs_does_not_exist').catch((e: unknown) => e);
        expect(failure).toMatchObject({ kind: 'not_found', mayHaveApplied: false });
      }),
    );
  });
}
