import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommerceProviderError,
  StripeCommerceProvider,
  stripeAmountAllowed,
  stripeError,
} from '../../src/commerce/index.js';
import { parseStripeForm, startFakeStripe } from '../../src/commerce/testing.js';
import { type CommerceKit, describeCommerceContract, type SignedDelivery } from './contract.js';

const SECRET = 'whsec_stripe_contract';

function sign(event: object, secret: string, at = new Date()): SignedDelivery {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return {
    rawBody: Buffer.from(payload),
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
  };
}

const stripeKit: CommerceKit = {
  name: 'stripe (SDK against the fake Stripe server)',
  async setup() {
    const fake = await startFakeStripe();
    const provider = new StripeCommerceProvider({
      apiKey: fake.apiKey,
      apiBase: fake.url,
      currencies: ['AED', 'USD'],
      shipping: { amountMinor: 1000n, label: 'Delivery' },
      timeoutMs: 400,
    });
    const paths = { createCheckout: '/v1/checkout/sessions', createRefund: '/v1/refunds' };
    return {
      provider,
      control: {
        webhookSecret: SECRET,
        async pay(sessionId) {
          return (await fake.pay(sessionId)).map((event) => sign(event, SECRET));
        },
        async expire(sessionId) {
          return sign(await fake.expire(sessionId), SECRET);
        },
        async settleRefund(refundId, outcome) {
          return sign(await fake.settleRefund(refundId, outcome), SECRET);
        },
        loseAnswer(op) {
          fake.inject('POST', paths[op], 'timeout_after', 1200);
        },
        dropRequest(op) {
          fake.inject('POST', paths[op], 'timeout_before', 1200);
        },
        setPrice(productId, amountMinor) {
          fake.setPrice(productId, Number(amountMinor));
        },
        sessionCount: () => fake.sessions.size,
        chargeCount: () => fake.paymentIntents.size,
        sign: (event, options = {}) => sign(event, options.secret ?? SECRET, options.at),
      },
      close: () => fake.close(),
    };
  },
};

describeCommerceContract(stripeKit);

describe('Stripe adapter specifics', () => {
  it('sends the approved amounts, our reference and a stable idempotency key', async () => {
    const fake = await startFakeStripe();
    try {
      const provider = new StripeCommerceProvider({
        apiKey: fake.apiKey,
        apiBase: fake.url,
        currencies: ['AED'],
        shipping: { amountMinor: 1000n, label: 'Delivery' },
      });
      const quote = await provider.quote({
        currency: 'AED',
        lines: [{ productId: 'prod_pens', variantId: 'price_pens', quantity: 2 }],
      });
      // The list price changes after the quote: the customer still pays what they approved.
      fake.setPrice('prod_pens', 9999);
      const session = await provider.createCheckout({
        reference: 'op_ref_1',
        idempotencyKey: 'hv:checkout:op_ref_1',
        quote,
        successUrl: 'https://widget.example/checkout-return.html?result=success',
        cancelUrl: 'https://widget.example/checkout-return.html?result=cancel',
        expiresAt: new Date(Date.now() + 3600_000),
        metadata: { hv_tenant: 'tnt_x' },
      });
      expect(session.amountTotalMinor).toBe(4000n);
      const created = fake.requests.find(
        (r) => r.method === 'POST' && r.path === '/v1/checkout/sessions',
      );
      expect(created?.idempotencyKey).toBe('hv:checkout:op_ref_1');
      const stored = fake.sessions.get(session.id);
      expect(stored).toMatchObject({
        client_reference_id: 'op_ref_1',
        metadata: { hv_tenant: 'tnt_x', hv_reference: 'op_ref_1' },
        amount_total: 4000,
      });
    } finally {
      await fake.close();
    }
  });

  it('refuses to use keys the fake does not know, as Stripe would', async () => {
    const fake = await startFakeStripe();
    try {
      const provider = new StripeCommerceProvider({
        apiKey: 'sk_test_wrong',
        apiBase: fake.url,
        currencies: ['AED'],
      });
      await expect(provider.searchCatalog({ limit: 5 })).rejects.toMatchObject({
        kind: 'auth',
        mayHaveApplied: false,
      });
    } finally {
      await fake.close();
    }
  });

  it('treats server errors as possibly applied, and refusals as not applied', () => {
    const cases: [object, string, boolean][] = [
      [
        { type: 'StripeConnectionError', message: 'Request aborted due to timeout being reached' },
        'timeout',
        true,
      ],
      [{ type: 'StripeConnectionError', message: 'socket hang up' }, 'network', true],
      [{ type: 'StripeAPIError', statusCode: 500 }, 'unavailable', true],
      [{ type: 'StripeRateLimitError', statusCode: 429 }, 'rate_limited', false],
      [{ type: 'StripeAuthenticationError', statusCode: 401 }, 'auth', false],
      [{ type: 'StripePermissionError', statusCode: 403 }, 'auth', false],
      [{ type: 'StripeIdempotencyError', statusCode: 400 }, 'idempotency_conflict', false],
      [{ type: 'StripeCardError', statusCode: 402 }, 'card_declined', false],
      [
        { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' },
        'not_found',
        false,
      ],
      [{ type: 'StripeInvalidRequestError', statusCode: 400 }, 'invalid_request', false],
      [{ message: 'something else' }, 'unknown', true],
    ];
    for (const [input, kind, mayHaveApplied] of cases) {
      const mapped = stripeError(input);
      expect(mapped).toBeInstanceOf(CommerceProviderError);
      expect([mapped.kind, mapped.mayHaveApplied]).toEqual([kind, mayHaveApplied]);
    }
  });

  it('knows which amounts Stripe can charge exactly', () => {
    expect(stripeAmountAllowed('AED', 6000n)).toBe(true);
    expect(stripeAmountAllowed('JPY', 1500n)).toBe(true);
    expect(stripeAmountAllowed('KWD', 1500n)).toBe(true);
    expect(stripeAmountAllowed('KWD', 1505n)).toBe(false);
    expect(stripeAmountAllowed('HUF', 150_000n)).toBe(true);
    expect(stripeAmountAllowed('HUF', 150_050n)).toBe(false);
    expect(stripeAmountAllowed('ISK', 1500n)).toBe(false);
    expect(stripeAmountAllowed('XYZ', 1n)).toBe(false);
    const provider = new StripeCommerceProvider({
      apiKey: 'sk_test_x',
      currencies: ['AED', 'ISK', 'XYZ'],
    });
    expect(provider.capabilities().currencies).toEqual(['AED']);
  });

  it('parses Stripe form encoding', () => {
    expect(
      parseStripeForm(
        'mode=payment&line_items[0][quantity]=2&line_items[0][price_data][currency]=aed&metadata[hv_reference]=op%201&expand[]=data.product',
      ),
    ).toEqual({
      mode: 'payment',
      line_items: [{ quantity: '2', price_data: { currency: 'aed' } }],
      metadata: { hv_reference: 'op 1' },
      expand: ['data.product'],
    });
  });
});
