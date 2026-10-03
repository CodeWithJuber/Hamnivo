import {
  type FakeStripeBilling,
  signBillingEvent,
  startFakeStripeBilling,
} from '@hamnivo/adapters/billing/testing';
import { closeDb, createDb, type Db, fromPublicId, schema, withTenant } from '@hamnivo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingLifecycleService } from '../src/billing/lifecycle.service.js';
import { BillingOperations } from '../src/billing/operations.js';
import { tenantWithOwner } from './access-support.js';
import type { Client } from './harness.js';
import { type Slice, startSlice } from './slice-harness.js';

/**
 * Stripe Billing (SaaS item 3): Upgrade opens a subscription Checkout, Manage opens the Customer
 * Portal, and signed webhooks become plans, each event once and in any order, with a grace period
 * after a failed payment. Stripe is the fake Stripe Billing server, never the real one.
 */

const SECRET = 'whsec_saas_billing_test';
const DAY = 86_400_000;

let fake: FakeStripeBilling;
let slice: Slice;
let platform: Db;
let owner: Client;
let tenantId: string;

type Json = Record<string, unknown>;

async function deliver(event: Json, secret = SECRET) {
  const { rawBody, headers } = signBillingEvent(event, secret);
  const response = await slice.gw.app.inject({
    method: 'POST',
    url: '/v1/integrations/billing/stripe',
    payload: rawBody,
    headers,
  });
  return { status: response.statusCode, body: response.json() as Json };
}

async function deliverAll(events: Json[]) {
  for (const event of events) {
    const reply = await deliver(event);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  }
}

async function state() {
  return withTenant(slice.app, { tenantId }, async (tx) => {
    const [account] = await tx.select().from(schema.billingAccounts);
    const [entitlement] = await tx.select().from(schema.tenantEntitlements);
    const events = await tx.select().from(schema.billingEvents);
    return { account, entitlement, events };
  });
}

const lifecycle = (offsetMs: number) =>
  new BillingLifecycleService(slice.app, null as never, () => new Date(Date.now() + offsetMs));

beforeAll(async () => {
  fake = await startFakeStripeBilling({
    prices: [
      { id: 'price_test_pro', unitAmount: 4900, currency: 'usd' },
      { id: 'price_test_team', unitAmount: 9900, currency: 'usd' },
    ],
  });
  slice = await startSlice({
    env: {
      HAMNIVO_DEFAULT_PLAN: 'free',
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: fake.apiKey,
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_BASE: fake.url,
    },
  });
  platform = createDb(slice.gw.database.platform, { max: 1 });
  const operations = new BillingOperations({
    platform,
    app: slice.app,
    operator: 'ops',
    dueDays: 14,
  });
  await operations.setPlan({
    key: 'pro',
    name: 'Pro',
    currency: 'USD',
    priceMinor: '4900',
    limits: { seats: 10, conversations: 2000, webhookEndpoints: 5 },
    stripePriceId: 'price_test_pro',
  });
  await operations.setPlan({
    key: 'team',
    name: 'Team',
    currency: 'USD',
    priceMinor: '9900',
    limits: { seats: 25 },
    stripePriceId: 'price_test_team',
  });
  owner = await tenantWithOwner(slice.gw, 'Bea Billing', 'bea@example.com', 'bea-co');
  tenantId = fromPublicId('tenant', owner.tenant as string);
});

afterAll(async () => {
  if (platform) await closeDb(platform);
  await slice?.close();
  await fake?.close();
});

describe('Upgrade through Stripe Checkout', () => {
  let subscriptionId = '';

  it('offers the plans Stripe sells, on the free plan to start with', async () => {
    const subscription = await owner.get('/v1/admin/billing/subscription');
    expect(subscription.status, JSON.stringify(subscription.body)).toBe(200);
    expect(subscription.body).toMatchObject({
      provider: 'free',
      status: 'none',
      plan: { key: 'free' },
      canUpgrade: true,
      canManage: false,
    });
    const offered = Object.fromEntries(
      subscription.body.plans.map((p: { key: string; purchasable: boolean }) => [
        p.key,
        p.purchasable,
      ]),
    );
    expect(offered).toEqual({ free: false, pro: true, team: true });
    // Nothing to manage before there is a customer.
    expect((await owner.post('/v1/admin/billing/portal')).status).toBe(403);
  });

  it('opens a subscription checkout that names the workspace, with one customer only', async () => {
    const first = await owner.post('/v1/admin/billing/checkout', { planKey: 'pro' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.url).toContain(`${fake.url}/checkout/cs_test_`);
    // A second click opens another page for the same customer.
    const second = await owner.post(
      '/v1/admin/billing/checkout',
      { planKey: 'pro' },
      { headers: { 'idempotency-key': 'click-2' } },
    );
    expect(second.status).toBe(200);
    expect(fake.customers.size).toBe(1);
    const [customer] = [...fake.customers.values()];
    expect(customer?.metadata).toEqual({ hv_tenant: owner.tenant });
    const session = [...fake.sessions.values()].at(-1) as Json;
    expect(session).toMatchObject({
      client_reference_id: owner.tenant,
      metadata: { hv_tenant: owner.tenant, hv_plan: 'pro' },
      success_url: 'http://localhost:5173/settings/billing?checkout=done',
    });
    // Plans Stripe does not sell cannot be bought.
    const free = await owner.post('/v1/admin/billing/checkout', { planKey: 'free' });
    expect(free.status).toBe(422);
  });

  it('turns the paid checkout into the plan, a receipt, and applies each event once', async () => {
    const session = [...fake.sessions.values()].at(-1) as Json;
    const events = fake.completeCheckout(String(session.id));
    await deliverAll(events);
    const after = await state();
    subscriptionId = String(after.account?.subscriptionRef);
    expect(after.account).toMatchObject({
      provider: 'stripe',
      subscriptionStatus: 'active',
      planKey: 'pro',
      paymentFailedAt: null,
      graceEndsAt: null,
    });
    expect(subscriptionId).toMatch(/^sub_test_/);
    expect(after.entitlement).toMatchObject({ planKey: 'pro', trialEndsAt: null });
    expect(after.entitlement?.limits).toMatchObject({ seats: 10 });
    expect(after.events.map((e) => e.type).sort()).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'invoice.paid',
    ]);

    // Stripe redelivers: nothing changes and nothing is recorded twice.
    await deliverAll(events);
    expect((await state()).events).toHaveLength(3);
    const audit = await owner.get('/v1/admin/audit?action=billing.plan_assigned&limit=10');
    expect(audit.body.items.map((e: { data: { source: string; plan: string } }) => e.data)).toEqual(
      [
        expect.objectContaining({ plan: 'pro', source: 'stripe' }),
        expect.objectContaining({ plan: 'free', source: 'default' }),
      ],
    );

    // The owner gets a receipt, as HTML with a plain-text version.
    await slice.drain();
    const receipt = slice.workerMailer.last('bea@example.com', 'billing.receipt');
    expect(receipt?.subject).toBe("Receipt for Bea Billing's workspace: $49.00");
    expect(receipt?.html).toContain('Payment received');
    expect(receipt?.senderName).toBe("Bea Billing's workspace");

    const subscription = await owner.get('/v1/admin/billing/subscription');
    expect(subscription.body).toMatchObject({
      provider: 'stripe',
      status: 'active',
      plan: { key: 'pro', name: 'Pro' },
      canUpgrade: false,
      canManage: true,
    });
    // A live subscription is changed in the portal, never doubled.
    expect((await owner.post('/v1/admin/billing/checkout', { planKey: 'team' })).status).toBe(409);
    const portal = await owner.post('/v1/admin/billing/portal');
    expect(portal.status, JSON.stringify(portal.body)).toBe(200);
    expect(portal.body.url).toContain(`${fake.url}/portal/`);
    const invoices = await owner.get('/v1/admin/billing/provider-invoices');
    expect(invoices.body.items).toEqual([
      expect.objectContaining({ status: 'paid', currency: 'USD', totalMinor: '4900' }),
    ]);
  });

  it('follows a plan change made in the portal', async () => {
    await deliverAll(fake.changePrice(subscriptionId, 'price_test_team'));
    expect((await state()).entitlement).toMatchObject({ planKey: 'team' });
    await deliverAll(fake.changePrice(subscriptionId, 'price_test_pro'));
    expect((await state()).entitlement).toMatchObject({ planKey: 'pro' });
  });

  it('keeps the plan through a failed payment until the grace period ends, in any event order', async () => {
    const [failed, pastDue] = fake.failPayment(subscriptionId) as [Json, Json];
    // The subscription's report first, then the invoice's: the same end state.
    await deliverAll([pastDue, failed]);
    const during = await state();
    expect(during.account?.subscriptionStatus).toBe('past_due');
    expect(during.entitlement?.planKey).toBe('pro');
    const graceEnds = during.account?.graceEndsAt?.getTime() ?? 0;
    expect(Math.abs(graceEnds - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    await slice.drain();
    const notice = slice.workerMailer.last('bea@example.com', 'billing.payment_failed');
    expect(notice?.text).toContain('We could not collect $49.00');
    expect(notice?.text).toMatch(/stays as it is until \w+ \d+, \d{4}/);

    // A retry that worked: active again, the dunning cycle over.
    const [paid, active] = fake.payLatestInvoice(subscriptionId) as [Json, Json];
    await deliverAll([active, paid]);
    expect((await state()).account).toMatchObject({
      subscriptionStatus: 'active',
      paymentFailedAt: null,
      graceEndsAt: null,
    });

    // Another failure, never paid: after seven days the workspace falls back to free.
    await deliverAll(fake.failPayment(subscriptionId));
    expect(await lifecycle(6 * DAY).processLapses()).toEqual({ trials: 0, graces: 0 });
    expect(await lifecycle(8 * DAY).processLapses()).toEqual({ trials: 0, graces: 1 });
    expect(await lifecycle(9 * DAY).processLapses()).toEqual({ trials: 0, graces: 0 });
    const lapsed = await state();
    expect(lapsed.entitlement?.planKey).toBe('free');
    expect(lapsed.account).toMatchObject({ subscriptionStatus: 'past_due', graceEndsAt: null });

    // Stripe gives up and cancels: still free, and Upgrade is offered again.
    await deliverAll(fake.cancel(subscriptionId));
    const ended = await state();
    expect(ended.account?.subscriptionStatus).toBe('canceled');
    expect(ended.entitlement?.planKey).toBe('free');
    expect((await owner.get('/v1/admin/billing/subscription')).body.canUpgrade).toBe(true);
  });
});

describe('the Stripe webhook', () => {
  const event = (id: string): Json => ({
    id,
    object: 'event',
    type: 'invoice.paid',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: 'in_unknown',
        object: 'invoice',
        currency: 'usd',
        created: 1,
        customer: 'cus_nobody',
      },
    },
  });

  it('refuses requests Stripe did not sign', async () => {
    expect((await deliver(event('evt_x'), 'whsec_wrong')).status).toBe(422);
    const unsigned = await slice.gw.app.inject({
      method: 'POST',
      url: '/v1/integrations/billing/stripe',
      payload: JSON.stringify(event('evt_y')),
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(422);
  });

  it('acknowledges events about no workspace without changing anything', async () => {
    const before = (await state()).events.length;
    expect((await deliver(event('evt_nobody'))).status).toBe(200);
    expect((await state()).events).toHaveLength(before);
  });
});
