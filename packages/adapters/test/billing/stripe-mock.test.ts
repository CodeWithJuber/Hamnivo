import { describe, expect, it } from 'vitest';
import { StripeBillingProvider } from '../../src/billing/index.js';

/**
 * Request shapes against the official stripe-mock server, which validates every request against
 * Stripe's OpenAPI specification and answers with fixtures (it keeps no state, so values are not
 * checked here; the stateful behaviour is covered with the fake server). Runs when STRIPE_MOCK_URL
 * points at a stripe-mock instance, e.g.
 *   docker run --rm -p 12111:12111 stripe/stripe-mock:latest
 *   STRIPE_MOCK_URL=http://127.0.0.1:12111 pnpm --filter @hamnivo/adapters test
 */
const url = process.env.STRIPE_MOCK_URL;

describe.skipIf(!url)('Stripe Billing requests accepted by stripe-mock', () => {
  const provider = new StripeBillingProvider({
    apiKey: 'sk_test_123',
    apiBase: url ?? 'http://127.0.0.1:12111',
  });

  it('creates a customer, a subscription checkout and a portal session', async () => {
    const { customerRef } = await provider.createCustomer({
      tenantRef: 'tnt_mock',
      name: 'Mock Co',
      email: 'owner@mock.example',
      idempotencyKey: 'hv:customer:tnt_mock',
    });
    expect(customerRef).toMatch(/^cus_/);
    const checkout = await provider.createCheckout({
      tenantRef: 'tnt_mock',
      customerRef,
      planKey: 'pro',
      priceRef: 'price_123',
      trialDays: 14,
      successUrl: 'https://studio.example/settings/billing?checkout=done',
      cancelUrl: 'https://studio.example/settings/billing',
      idempotencyKey: 'hv:checkout:tnt_mock:1',
    });
    expect(checkout.ref).toMatch(/^cs_/);
    const portal = await provider.createPortal({
      customerRef,
      returnUrl: 'https://studio.example/settings/billing',
    });
    expect(portal.url).toMatch(/^https?:\/\//);
  });

  it('lists invoices and reads a subscription', async () => {
    expect(Array.isArray(await provider.listInvoices('cus_123', 10))).toBe(true);
    const subscription = await provider.getSubscription('sub_123');
    expect(subscription?.ref).toMatch(/^sub_/);
  });
});
