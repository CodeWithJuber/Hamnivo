import { randomUUID } from 'node:crypto';
import { ScriptedCollection } from '@hamnivo/adapters/billing';
import { closeDb, createDb, type Db, fromPublicId, schema, withTenant } from '@hamnivo/db';
import { periodOf, previousPeriod } from '@hamnivo/domain/billing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingOperationError, BillingOperations } from '../src/billing/operations.js';
import { WebhookDispatcher } from '../src/developer/webhooks/dispatcher.service.js';
import { Receiver, withTwoStep } from './developer-support.js';
import { customerStarts, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

let slice: Slice;
let shop: Shop;
let platform: Db;
let operations: BillingOperations;
let receiver: Receiver;

const STARTER = {
  key: 'starter',
  name: 'Starter',
  currency: 'EUR',
  priceMinor: '4900',
  limits: {
    conversations: 3,
    aiReplies: 1,
    aiTokens: null,
    knowledgeStorageBytes: 1500,
    seats: 2,
    webhookEndpoints: 1,
  },
  metered: [
    { limit: 'conversations', includedUnits: 1, unitPriceMinor: '100', perUnits: 1 },
    { limit: 'aiReplies', includedUnits: 0, unitPriceMinor: '10', perUnits: 1 },
  ],
} as const;

const tenantId = () => fromPublicId('tenant', shop.tenantId);

async function settle() {
  await slice.drain();
  const dispatcher = slice.worker.get(WebhookDispatcher);
  while ((await dispatcher.drainOnce()) > 0) {
    // until nothing is due
  }
}

async function meter(limit: string) {
  const usage = await shop.owner.get('/v1/admin/usage');
  return usage.body.meters.find((m: { limit: string }) => m.limit === limit);
}

beforeAll(async () => {
  receiver = await new Receiver().start();
  slice = await startSlice({ env: { EGRESS_TRUSTED_ORIGINS: receiver.origin } });
  shop = await connectedTenant(slice, 'bill');
  platform = createDb(slice.gw.database.platform, { max: 1 });
  operations = new BillingOperations({
    platform,
    app: slice.app,
    operator: 'ops@hamnivo',
    dueDays: 14,
  });
});

afterAll(async () => {
  if (platform) await closeDb(platform);
  await slice?.close();
  await receiver?.close();
});

describe('plans and limits', () => {
  it('limits nothing until a plan is assigned', async () => {
    const usage = await shop.owner.get('/v1/admin/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.limited).toBe(false);
    expect(usage.body.meters.every((m: { state: string }) => m.state === 'unlimited')).toBe(true);
    expect(usage.body.ai).toEqual({ allowed: true, reason: null });
    const billing = await shop.owner.get('/v1/admin/billing');
    expect(billing.body).toMatchObject({ plan: null, standing: 'no_plan', invoices: [] });
  });

  it('lets the operator define and assign a plan, audited in the tenant', async () => {
    await expect(
      operations.setPlan({ ...STARTER, key: 'broken', currency: 'XXX1' } as never),
    ).rejects.toThrow();
    const plan = await operations.setPlan(STARTER as never);
    expect(plan?.key).toBe('starter');
    await operations.assignPlan('bill-store', 'starter');
    await expect(operations.assignPlan('bill-store', 'missing')).rejects.toBeInstanceOf(
      BillingOperationError,
    );
    const billing = await shop.owner.get('/v1/admin/billing');
    expect(billing.body.plan).toMatchObject({
      key: 'starter',
      priceMinor: '4900',
      limits: STARTER.limits,
    });
    expect(billing.body.standing).toBe('active');
    expect(await meter('seats')).toMatchObject({ used: 1, max: 2, kind: 'capacity' });
    const audit = await shop.owner.get('/v1/admin/audit?action=billing.plan_assigned');
    expect(audit.body.items[0]).toMatchObject({
      actor: { type: 'platform', id: 'ops@hamnivo' },
      data: { plan: 'starter', previous: null },
    });
  });

  it('refuses a webhook endpoint beyond the plan with 402 and the numbers', async () => {
    const first = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: `${receiver.origin}/usage`,
      eventTypes: ['usage.threshold_reached'],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await shop.owner.post('/v1/admin/webhooks/endpoints', {
      url: `${receiver.origin}/more`,
      eventTypes: ['order.created'],
    });
    expect(second.status).toBe(402);
    expect(second.body).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      type: 'https://hamnivo.dev/problems/plan-limit-reached',
      quota: { scope: 'plan', limit: 'webhookEndpoints', max: 1, used: 1, resetsAt: null },
    });
  });

  it('refuses a seat beyond the plan, counting pending invitations', async () => {
    const roles = await shop.owner.get('/v1/admin/roles');
    const roleId = roles.body.items.find((r: { key: string }) => r.key === 'agent').id;
    const invite = (email: string) =>
      shop.owner.post('/v1/admin/invitations', { email, roleId, scope: { type: 'tenant' } });
    expect((await invite('seat-one@example.com')).status).toBe(201);
    const refused = await invite('seat-two@example.com');
    expect(refused.status, JSON.stringify(refused.body)).toBe(402);
    expect(refused.body.quota).toEqual({
      scope: 'plan',
      limit: 'seats',
      max: 2,
      used: 2,
      resetsAt: null,
    });
    expect(await meter('seats')).toMatchObject({ used: 2, max: 2, state: 'reached' });
  });

  it('refuses knowledge beyond the storage in the plan', async () => {
    const source = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: shop.brand.id,
      name: 'Help',
    });
    const add = (title: string) =>
      shop.owner.post(`/v1/admin/knowledge/sources/${source.body.id}/documents`, {
        title,
        content: {
          mediaType: 'text/markdown',
          text: `# ${title}\n\n${'Opening hours. '.repeat(60)}`,
        },
      });
    expect((await add('Hours')).status).toBe(202);
    const refused = await add('More hours');
    expect(refused.status).toBe(402);
    expect(refused.body.quota).toMatchObject({ limit: 'knowledgeStorageBytes', max: 1500 });
  });

  it('hands conversations to people once the AI replies are used up, and alerts', async () => {
    receiver.reset();
    const first = await customerStarts(slice, shop, 'Do you ship to Dubai?');
    await settle();
    const second = await customerStarts(slice, shop, 'Can I change my order?');
    await settle();
    const [one, two] = await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
      Promise.all(
        [first.conversationId, second.conversationId].map(async (id) => {
          const [row] = await tx
            .select()
            .from(schema.conversationControls)
            .where(eq(schema.conversationControls.id, fromPublicId('conversation', id)));
          return row;
        }),
      ),
    );
    expect(one?.ownerMode).toBe('AI_ACTIVE');
    expect(two).toMatchObject({ ownerMode: 'WAITING_HUMAN', ownerReason: 'ai_limit' });
    expect(await meter('aiReplies')).toMatchObject({ used: 1, max: 1, state: 'reached' });
    const usage = await shop.owner.get('/v1/admin/usage');
    expect(usage.body.ai).toEqual({ allowed: false, reason: 'plan_replies' });
    expect(usage.body.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          limit: 'aiReplies',
          source: 'plan',
          threshold: 100,
          used: 1,
          max: 1,
        }),
      ]),
    );
    // The alert reached the endpoint subscribed to it, once per threshold.
    const alerts = receiver.at('/usage').map((r) => r.json);
    expect(alerts.map((a) => [a.type, a.data.limit, a.data.threshold])).toEqual(
      expect.arrayContaining([
        ['usage.threshold_reached', 'aiReplies', 80],
        ['usage.threshold_reached', 'aiReplies', 100],
      ]),
    );
    expect(alerts.filter((a) => a.data.limit === 'aiReplies')).toHaveLength(2);
  });

  it('refuses a new conversation past the plan, without telling the customer the plan', async () => {
    await customerStarts(slice, shop, 'Third conversation');
    await settle();
    expect(await meter('conversations')).toMatchObject({ used: 3, max: 3, state: 'reached' });
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    const refused = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Fourth conversation',
      clientMessageId: randomUUID(),
    });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');
    expect(refused.body.quota).toBeUndefined();
    expect(JSON.stringify(refused.body)).not.toMatch(/\b3\b|starter|plan allows/i);
  });

  it('lets the workspace set a budget within the plan', async () => {
    await operations.setPlan({
      ...STARTER,
      key: 'growth',
      name: 'Growth',
      limits: { ...STARTER.limits, aiTokens: 1000, aiReplies: 100, conversations: 100 },
    } as never);
    await operations.assignPlan(shop.tenantId, 'growth');
    const tooHigh = await shop.owner.put('/v1/admin/billing/budget', {
      aiTokens: 2000,
      alertThresholds: [50, 90],
    });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.fields[0].path).toBe('aiTokens');
    const set = await shop.owner.put('/v1/admin/billing/budget', {
      aiTokens: 500,
      alertThresholds: [90, 50, 90],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ aiTokens: 500, alertThresholds: [50, 90] });
    const audit = await shop.owner.get('/v1/admin/audit?action=billing.budget_updated');
    expect(audit.body.items[0].data).toEqual({ aiTokens: 500, alertThresholds: [50, 90] });
    // A smaller plan lowers a budget that no longer fits.
    await operations.setPlan({
      ...STARTER,
      key: 'tiny',
      name: 'Tiny',
      limits: { ...STARTER.limits, aiTokens: 100, conversations: 100, aiReplies: 100 },
    } as never);
    await operations.assignPlan(shop.tenantId, 'tiny');
    expect((await shop.owner.get('/v1/admin/usage')).body.budget.aiTokens).toBe(100);
  });
});

describe('invoices', () => {
  const last = previousPeriod(periodOf(new Date()));
  /** The operator 100 days ago: a plan assigned then covers the last two months. */
  const earlier = () =>
    new BillingOperations({
      platform,
      app: slice.app,
      operator: 'ops@hamnivo',
      dueDays: 14,
      clock: () => new Date(Date.now() - 100 * 86_400_000),
    });

  it('drafts invoices from metered usage, shows them once issued, and records payment', async () => {
    // Assigned today, the plan did not cover last month, so nothing is owed for it.
    await operations.assignPlan(shop.tenantId, 'starter');
    await withTenant(slice.app, { tenantId: tenantId() }, (tx) =>
      tx.insert(schema.usageEntries).values([
        {
          tenantId: tenantId(),
          meter: 'conversations',
          quantity: 5,
          unit: 'conversation',
          occurredAt: new Date(last.start.getTime() + 86_400_000),
          dedupeKey: `test:${randomUUID()}`,
        },
        {
          tenantId: tenantId(),
          meter: 'ai.replies',
          quantity: 7,
          unit: 'reply',
          occurredAt: new Date(last.end.getTime() - 1000),
          dedupeKey: `test:${randomUUID()}`,
        },
      ]),
    );
    await expect(operations.generateInvoices(periodOf(new Date()).key)).rejects.toThrow(/not over/);
    expect(
      (await operations.generateInvoices(last.key)).filter((d) => d.tenantId === tenantId()),
    ).toEqual([]);
    await earlier().assignPlan(shop.tenantId, 'starter');
    const drafts = await operations.generateInvoices(last.key);
    const mine = drafts.filter((d) => d.tenantId === tenantId());
    expect(mine).toHaveLength(1);
    const draft = mine[0] as (typeof mine)[number];
    // 49.00 plan + 4 conversations beyond the 1 included at 1.00 + 7 AI replies at 0.10.
    expect(draft.totalMinor).toBe(4900n + 400n + 70n);
    expect(draft.status).toBe('draft');
    // A draft is the operator's: the workspace does not see it yet.
    expect((await shop.owner.get('/v1/admin/billing/invoices')).body.items).toEqual([]);
    // Running again creates nothing new.
    expect(
      (await operations.generateInvoices(last.key)).filter((d) => d.tenantId === tenantId()),
    ).toEqual([]);

    const issued = await operations.issue(draft.number);
    expect(issued.status).toBe('issued');
    const list = await shop.owner.get('/v1/admin/billing/invoices');
    expect(list.body.items).toHaveLength(1);
    const summary = list.body.items[0];
    expect(summary).toMatchObject({
      number: draft.number,
      status: 'issued',
      totalMinor: '5370',
      currency: 'EUR',
      overdue: false,
      period: { key: last.key },
      payment: { method: 'manual', state: 'none' },
    });
    const detail = await shop.owner.get(`/v1/admin/billing/invoices/${summary.id}`);
    expect(
      detail.body.lines.map((l: { kind: string; limit: string | null; amountMinor: string }) => [
        l.kind,
        l.limit,
        l.amountMinor,
      ]),
    ).toEqual([
      ['plan', null, '4900'],
      ['metered', 'conversations', '400'],
      ['metered', 'aiReplies', '70'],
    ]);
    expect(detail.body.usage).toMatchObject({ conversations: 5, aiReplies: 7 });

    await operations.recordPaymentFailure(
      draft.number,
      'card declined',
      new Date(Date.now() + 86_400_000),
    );
    const failed = await shop.owner.get(`/v1/admin/billing/invoices/${summary.id}`);
    expect(failed.body.payment).toMatchObject({ state: 'failed' });
    expect(failed.body.payment.nextRetryAt).not.toBeNull();

    const paid = await operations.markPaid(summary.id, 'bank-transfer-0042');
    expect(paid.status).toBe('paid');
    await expect(operations.voidInvoice(summary.id, 'mistake')).rejects.toThrow(
      /paid cannot become void/,
    );
    const after = await shop.owner.get(`/v1/admin/billing/invoices/${summary.id}`);
    expect(after.body).toMatchObject({ status: 'paid', payment: { state: 'paid' } });
    const audit = await shop.owner.get('/v1/admin/audit?action=billing.invoice_paid');
    expect(audit.body.items[0]).toMatchObject({
      actor: { type: 'platform' },
      target: { id: summary.id },
    });
  });

  it('marks overdue invoices and collects through a payment port', async () => {
    const twoAgo = previousPeriod(last);
    const late = new BillingOperations({
      platform,
      app: slice.app,
      operator: 'ops@hamnivo',
      dueDays: 14,
      clock: () => new Date(Date.now() - 30 * 86_400_000),
    });
    const [draft] = (await operations.generateInvoices(twoAgo.key)).filter(
      (d) => d.tenantId === tenantId(),
    );
    if (!draft) throw new Error('no draft');
    await late.issue(draft.number);
    const billing = await shop.owner.get('/v1/admin/billing');
    expect(billing.body.standing).toBe('past_due');
    expect(
      billing.body.invoices.find((i: { number: string }) => i.number === draft.number).overdue,
    ).toBe(true);
    const voided = await operations.voidInvoice(draft.number, 'issued by mistake');
    expect(voided.status).toBe('void');
    expect((await shop.owner.get('/v1/admin/billing')).body.standing).toBe('active');

    // With a provider behind the port, issuing collects at once.
    const port = new ScriptedCollection([
      { status: 'paid', providerRef: 'in_test_1', paidAt: new Date() },
    ]);
    const auto = new BillingOperations({
      platform,
      app: slice.app,
      operator: 'ops@hamnivo',
      dueDays: 14,
      payments: port,
    });
    const [again] = (await auto.generateInvoices(twoAgo.key)).filter(
      (d) => d.tenantId === tenantId(),
    );
    if (!again) throw new Error('no second draft');
    expect(again.number).toMatch(/-2$/);
    const collected = await auto.issue(again.number);
    expect(collected).toMatchObject({
      status: 'paid',
      paymentMethod: 'provider',
      paymentReference: 'in_test_1',
    });
    expect(port.calls[0]).toMatchObject({ number: again.number, currency: 'EUR' });
  });

  it('shows invoices to API keys with billing.read and to no other tenant', async () => {
    const list = await shop.owner.get('/v1/admin/billing/invoices');
    const id = list.body.items[0].id;
    const admin = await withTwoStep(slice.gw.app, shop.owner, 'bill-owner@example.com');
    const key = await admin.post('/v1/admin/api-keys', {
      name: 'Accounting',
      permissions: ['billing.read'],
      expiresInDays: 3,
    });
    const auth = { headers: { authorization: `Bearer ${key.body.secret}` }, tenant: null };
    const read = await admin.get(`/v1/admin/billing/invoices/${id}`, auth);
    expect(read.status).toBe(200);
    expect((await admin.get('/v1/admin/usage', auth)).status).toBe(200);
    expect(
      (await admin.put('/v1/admin/billing/budget', { aiTokens: null, alertThresholds: [] }, auth))
        .status,
    ).toBe(401);

    const other = await connectedTenant(slice, 'bill-other');
    expect((await other.owner.get(`/v1/admin/billing/invoices/${id}`)).status).toBe(404);
    expect((await other.owner.get('/v1/admin/billing/invoices')).body.items).toEqual([]);
    expect((await other.owner.get('/v1/admin/billing')).body.plan).toBeNull();
  });
});
