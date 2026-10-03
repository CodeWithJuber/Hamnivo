import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingProviderError,
  BillingWebhookSignatureError,
  FreeBillingProvider,
  mapStripeBillingEvent,
  mapStripeSubscription,
  StripeBillingProvider,
  subscriptionState,
  WhmcsBillingProvider,
} from '../../src/billing/index.js';
import {
  type FakeStripeBilling,
  signBillingEvent,
  startFakeStripeBilling,
} from '../../src/billing/testing.js';

const SECRET = 'whsec_billing_test';

let fake: FakeStripeBilling;
let provider: StripeBillingProvider;

beforeAll(async () => {
  fake = await startFakeStripeBilling({
    prices: [
      { id: 'price_test_pro', unitAmount: 4900, currency: 'usd' },
      { id: 'price_test_team', unitAmount: 9900, currency: 'usd' },
    ],
  });
  provider = new StripeBillingProvider({ apiKey: fake.apiKey, apiBase: fake.url, timeoutMs: 2000 });
});

afterAll(async () => {
  await fake?.close();
});

const verify = (event: Record<string, unknown>, at = new Date()) => {
  const { rawBody, headers } = signBillingEvent(event, SECRET, at);
  return provider.verifyWebhook(rawBody, headers, SECRET);
};

async function subscribe(tenantRef: string, trialDays = 0) {
  const { customerRef } = await provider.createCustomer({
    tenantRef,
    name: 'Northline',
    email: 'owner@northline.example',
    idempotencyKey: `hv:customer:${tenantRef}`,
  });
  const checkout = await provider.createCheckout({
    tenantRef,
    customerRef,
    planKey: 'pro',
    priceRef: 'price_test_pro',
    trialDays,
    successUrl: 'https://studio.example/settings/billing?checkout=done',
    cancelUrl: 'https://studio.example/settings/billing',
    idempotencyKey: `hv:checkout:${tenantRef}:1`,
  });
  return { customerRef, checkout };
}

describe('Stripe Billing provider (SDK against the fake Stripe Billing server)', () => {
  it('creates one customer per key, even when Stripe answers 500 and the SDK retries', async () => {
    fake.failNext('POST', '/v1/customers');
    const request = {
      tenantRef: 'tnt_retry',
      name: 'Retry Co',
      email: null,
      idempotencyKey: 'hv:customer:tnt_retry',
    };
    const first = await provider.createCustomer(request);
    const second = await provider.createCustomer(request);
    expect(second.customerRef).toBe(first.customerRef);
    const created = [...fake.customers.values()].filter(
      (c) => (c.metadata as Record<string, string>).hv_tenant === 'tnt_retry',
    );
    expect(created).toHaveLength(1);
    const posts = fake.requests.filter((r) => r.path === '/v1/customers' && r.method === 'POST');
    expect(new Set(posts.map((r) => r.idempotencyKey))).toEqual(new Set(['hv:customer:tnt_retry']));
  });

  it('starts a subscription checkout that names the workspace and plan', async () => {
    const { checkout } = await subscribe('tnt_checkout', 14);
    expect(checkout.url).toContain('/checkout/cs_test_');
    const session = fake.sessions.get(checkout.ref);
    expect(session).toMatchObject({
      mode: 'subscription',
      client_reference_id: 'tnt_checkout',
      metadata: { hv_tenant: 'tnt_checkout', hv_plan: 'pro' },
      subscription_data: {
        metadata: { hv_tenant: 'tnt_checkout', hv_plan: 'pro' },
        trial_period_days: '14',
      },
    });
  });

  it('reads the events of a paid checkout as billing events', async () => {
    const { checkout, customerRef } = await subscribe('tnt_paid');
    const events = fake.completeCheckout(checkout.ref).map((event) => verify(event));
    expect(events.map((e) => e.kind)).toEqual([
      'checkout.completed',
      'subscription.changed',
      'invoice.paid',
    ]);
    const [completed, changed, paid] = events;
    expect(completed).toMatchObject({ tenantRef: 'tnt_paid', customerRef });
    if (changed?.kind !== 'subscription.changed') throw new Error('expected a subscription');
    expect(changed.subscription).toMatchObject({
      state: 'active',
      priceRef: 'price_test_pro',
      tenantRef: 'tnt_paid',
      planKey: 'pro',
      customerRef,
      cancelAtPeriodEnd: false,
      trialEnd: null,
    });
    expect(changed.subscription.currentPeriodEnd?.getTime()).toBeGreaterThan(Date.now());
    if (paid?.kind !== 'invoice.paid') throw new Error('expected an invoice');
    expect(paid.invoice).toMatchObject({
      status: 'paid',
      currency: 'USD',
      totalMinor: 4900n,
      amountPaidMinor: 4900n,
      tenantRef: 'tnt_paid',
      subscriptionRef: changed.subscription.ref,
    });
    // The subscription as Stripe sees it now, and the customer's invoices.
    const current = await provider.getSubscription(changed.subscription.ref);
    expect(current?.state).toBe('active');
    expect(await provider.getSubscription('sub_missing')).toBeNull();
    const invoices = await provider.listInvoices(customerRef, 10);
    expect(invoices.map((i) => i.status)).toEqual(['paid']);
  });

  it('reads a failed renewal, a retry that worked and a cancellation', async () => {
    const { checkout } = await subscribe('tnt_dunning');
    const [, created] = fake.completeCheckout(checkout.ref).map((event) => verify(event));
    if (created?.kind !== 'subscription.changed') throw new Error('expected a subscription');
    const ref = created.subscription.ref;
    const [failed, pastDue] = fake.failPayment(ref).map((event) => verify(event));
    if (failed?.kind !== 'invoice.payment_failed') throw new Error('expected a failure');
    expect(failed.invoice).toMatchObject({ status: 'open', attemptCount: 1 });
    expect(failed.invoice.nextAttemptAt).toBeInstanceOf(Date);
    expect(pastDue).toMatchObject({ subscription: { state: 'past_due' } });
    const [paid, active] = fake.payLatestInvoice(ref).map((event) => verify(event));
    expect(paid?.kind).toBe('invoice.paid');
    expect(active).toMatchObject({ subscription: { state: 'active' } });
    const [deleted] = fake.cancel(ref).map((event) => verify(event));
    expect(deleted).toMatchObject({
      kind: 'subscription.deleted',
      subscription: { state: 'canceled' },
    });
  });

  it('opens the Customer Portal for the customer', async () => {
    const { customerRef } = await subscribe('tnt_portal');
    const portal = await provider.createPortal({
      customerRef,
      returnUrl: 'https://studio.example/settings/billing',
    });
    expect(portal.url).toContain('/portal/bps_test_');
  });

  it('refuses events that Stripe did not sign, signed with another secret, changed or old', () => {
    const event = {
      id: 'evt_x',
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: 'in_x', currency: 'usd', created: 1 } },
    };
    const signed = signBillingEvent(event, SECRET);
    expect(() => provider.verifyWebhook(signed.rawBody, {}, SECRET)).toThrow(
      BillingWebhookSignatureError,
    );
    expect(() => provider.verifyWebhook(signed.rawBody, signed.headers, 'whsec_other')).toThrow(
      /mismatch/,
    );
    const tampered = Buffer.from(signed.rawBody.toString('utf8').replace('evt_x', 'evt_y'));
    expect(() => provider.verifyWebhook(tampered, signed.headers, SECRET)).toThrow(/mismatch/);
    const old = signBillingEvent(event, SECRET, new Date(Date.now() - 3600_000));
    expect(() => provider.verifyWebhook(old.rawBody, old.headers, SECRET)).toThrow(/stale/);
    expect(() =>
      provider.verifyWebhook(signed.rawBody, { 'stripe-signature': 'nonsense' }, SECRET),
    ).toThrow(BillingWebhookSignatureError);
  });

  it('reports Stripe refusing a request as not retryable', async () => {
    const error = await provider
      .createCheckout({
        tenantRef: 'tnt_bad',
        customerRef: 'cus_missing',
        planKey: 'pro',
        priceRef: 'price_test_pro',
        trialDays: 0,
        successUrl: 'https://studio.example/ok',
        cancelUrl: 'https://studio.example/no',
        idempotencyKey: 'hv:checkout:bad',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BillingProviderError);
    expect(error).toMatchObject({ retryable: false });
  });
});

describe('Stripe shapes', () => {
  it('maps every subscription state, and reads unknown ones as incomplete', () => {
    expect(subscriptionState('incomplete_expired')).toBe('canceled');
    expect(subscriptionState('trialing')).toBe('trialing');
    expect(subscriptionState('something_new')).toBe('incomplete');
  });

  it('takes the earliest item period end and the subscription metadata', () => {
    const mapped = mapStripeSubscription({
      id: 'sub_1',
      customer: { id: 'cus_1' },
      status: 'active',
      metadata: { hv_tenant: 'tnt_1', hv_plan: 'team' },
      items: {
        data: [
          { price: { id: 'price_a' }, current_period_end: 2_000_000_000 },
          { price: { id: 'price_b' }, current_period_end: 1_900_000_000 },
        ],
      },
    });
    expect(mapped).toMatchObject({
      customerRef: 'cus_1',
      priceRef: 'price_a',
      tenantRef: 'tnt_1',
      planKey: 'team',
      currentPeriodEnd: new Date(1_900_000_000 * 1000),
    });
  });

  it('ignores payment-mode checkouts and events billing does not act on', () => {
    const base = { id: 'evt_1', created: 1, livemode: false };
    expect(
      mapStripeBillingEvent({
        ...base,
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', mode: 'payment' } },
      }).kind,
    ).toBe('ignored');
    expect(
      mapStripeBillingEvent({ ...base, type: 'invoice.payment_succeeded', data: { object: {} } })
        .kind,
    ).toBe('ignored');
  });
});

describe('free and WHMCS providers', () => {
  it('offer no checkout, and WHMCS links to its client area', async () => {
    const free = new FreeBillingProvider();
    expect(free.capabilities()).toEqual({
      checkout: false,
      portal: false,
      invoices: false,
      webhooks: false,
    });
    await expect(free.createPortal()).rejects.toMatchObject({ kind: 'unsupported' });
    expect(await free.listInvoices()).toEqual([]);
    const whmcs = new WhmcsBillingProvider({
      clientAreaUrl: 'https://billing.example/clientarea.php',
    });
    expect(whmcs.capabilities().portal).toBe(true);
    expect(await whmcs.createPortal()).toEqual({ url: 'https://billing.example/clientarea.php' });
    await expect(whmcs.createCheckout()).rejects.toBeInstanceOf(BillingProviderError);
    expect(new WhmcsBillingProvider({ clientAreaUrl: null }).capabilities().portal).toBe(false);
  });
});
