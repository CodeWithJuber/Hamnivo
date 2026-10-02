import { describe, expect, it } from 'vitest';
import { StripeCommerceProvider } from '../../src/commerce/index.js';

/**
 * Request shapes against the official stripe-mock server, which validates every request against
 * Stripe's OpenAPI specification and answers with fixtures (it keeps no state, so values are not
 * checked here; the stateful behaviour is covered by the contract suite). Runs when
 * STRIPE_MOCK_URL points at a stripe-mock instance, e.g.
 *   docker run --rm -p 12111:12111 stripe/stripe-mock:latest
 *   STRIPE_MOCK_URL=http://127.0.0.1:12111 pnpm --filter @hamnivo/adapters test
 */
const url = process.env.STRIPE_MOCK_URL;

describe.skipIf(!url)('Stripe adapter requests accepted by stripe-mock', () => {
  const provider = new StripeCommerceProvider({
    apiKey: 'sk_test_123',
    apiBase: url ?? 'http://127.0.0.1:12111',
    currencies: ['USD', 'AED'],
    shipping: { amountMinor: 1000n, label: 'Delivery' },
  });

  it('lists and reads prices', async () => {
    const catalog = await provider.searchCatalog({ limit: 10 });
    expect(Array.isArray(catalog.items)).toBe(true);
  });

  it('creates, reads, lists and expires checkout sessions', async () => {
    const session = await provider
      .createCheckout({
        reference: 'op_stripe_mock',
        idempotencyKey: 'hv:checkout:op_stripe_mock',
        quote: {
          currency: 'USD',
          lines: [
            {
              productId: 'prod_mock',
              variantId: null,
              name: 'Test',
              quantity: 2,
              unitPriceMinor: 1500n,
              totalMinor: 3000n,
            },
          ],
          subtotalMinor: 3000n,
          discountMinor: 0n,
          taxMinor: null,
          taxMode: 'included',
          shippingMinor: 1000n,
          totalMinor: 4000n,
          recurring: null,
          validUntil: null,
          observedAt: new Date(),
        },
        successUrl: 'https://widget.example/ok',
        cancelUrl: 'https://widget.example/cancel',
        expiresAt: new Date(Date.now() + 3600_000),
        metadata: { hv_tenant: 'tnt_x' },
      })
      // stripe-mock's fixture total differs from ours, so the adapter expires it and refuses.
      .catch((error: unknown) => error);
    expect(session).toMatchObject({ options: { code: 'amount_mismatch' } });
    const read = await provider.getCheckout('cs_test_123');
    expect(read.id).toMatch(/^cs_/);
    expect(await provider.findCheckout('op_none', new Date(Date.now() - 60_000))).toBeNull();
    const expired = await provider.expireCheckout('cs_test_123');
    expect(expired.id).toMatch(/^cs_/);
  });

  it('creates, reads and lists refunds', async () => {
    const refund = await provider.createRefund({
      reference: 'op_refund_mock',
      idempotencyKey: 'hv:refund:op_refund_mock',
      paymentRef: 'pi_123',
      amountMinor: 1500n,
      currency: 'USD',
      reason: 'requested_by_customer',
      metadata: { hv_refund: 'rfd_x' },
    });
    expect(refund.id).toMatch(/^re_/);
    expect((await provider.getRefund(refund.id)).id).toMatch(/^re_/);
    expect(await provider.findRefund('op_none', 'pi_123')).toBeNull();
  });
});
