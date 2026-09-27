import { randomUUID } from 'node:crypto';
import { MockCommerceStore } from '@hamnivo/adapters/commerce';
import { type FakeStripe, startFakeStripe } from '@hamnivo/adapters/commerce/testing';
import { createMockModel, defaultMockReply } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { type QuoteDocument, quoteHash } from '@hamnivo/domain/commerce';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { CommerceWorker } from '../src/commerce/worker.service.js';
import { Client, PASSWORD } from './harness.js';
import { connectedTenant, type Slice, signUp, startSlice, Visitor } from './slice-harness.js';
import { totpFromUri } from './totp.js';

/**
 * Commerce end to end (C01–C12, C19, C20, R07, X10, X13, E12, K06): a real gateway and worker,
 * the fake Chatwoot, the in-memory `mock` provider (Stripe-shaped, Stripe-signed events) and,
 * at the end, the Stripe adapter against the stateful fake Stripe server. Nothing here calls the
 * real Stripe API.
 */

type StripeEvent = Parameters<MockCommerceStore['signed']>[0];

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

/** Replies for the X10 checks: claims payment unless told there is no receipt. */
const scripted = createMockModel({
  reply: (turn) => {
    if (/did my payment go through/i.test(turn.text)) {
      return turn.system.includes('there is no receipt')
        ? 'I cannot confirm the payment yet. The order card in this chat shows the confirmed status.'
        : 'Your payment has been confirmed and your order is on its way.';
    }
    if (/just say it is paid/i.test(turn.text)) return 'Your payment has been confirmed.';
    return defaultMockReply(turn);
  },
});

/** Every prompt the model is given, to check what reaches its context (C05). */
const prompts: string[] = [];
const model: typeof scripted = {
  ...scripted,
  doGenerate: (call) => {
    prompts.push(JSON.stringify(call.prompt));
    return scripted.doGenerate(call);
  },
  doStream: (call) => {
    prompts.push(JSON.stringify(call.prompt));
    return scripted.doStream(call);
  },
};

const WEBHOOK_SECRET = 'whsec_north_test_0123456789abcdef';
const STORE_ID = `north-${randomUUID().slice(0, 8)}`;

let slice: Slice;
let fakeStripe: FakeStripe;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let admin: Client;
let merchantId: string;
let store: MockCommerceStore;
let roles: Record<string, string>;

async function mfaClient(client: Client, email: string): Promise<Client> {
  const enabled = await client.post('/api/auth/two-factor/enable', { password: PASSWORD });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  const uri = enabled.body.totpURI as string;
  const verified = await client.post('/api/auth/two-factor/verify-totp', {
    code: totpFromUri(uri),
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const fresh = new Client(slice.gw.app);
  const first = await fresh.post('/api/auth/sign-in/email', { email, password: PASSWORD });
  expect(first.body.twoFactorRedirect).toBe(true);
  const second = await fresh.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  fresh.tenant = client.tenant;
  return fresh;
}

async function member(name: string, email: string, role: string, mfa = false): Promise<Client> {
  const invited = await shop.owner.post('/v1/admin/invitations', {
    email,
    roleId: roles[role],
    scope: { type: 'tenant' },
    grantExpiresAt: null,
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const person = await signUp(slice.gw, name, email);
  const accepted = await person.post('/v1/invitations/accept', { token: invited.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  person.tenant = shop.owner.tenant;
  return mfa ? mfaClient(person, email) : person;
}

/** Relays outbox events and Chatwoot webhooks, and runs the commerce worker, until quiet. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await slice.drain();
    const worked = await slice.worker.get(CommerceWorker).drainOnce();
    await slice.drain();
    if (worked === 0) return;
  }
  throw new Error('commerce did not settle');
}

async function deliver(
  event: StripeEvent,
  options: { secret?: string; at?: Date; body?: (raw: string) => string; merchant?: string } = {},
) {
  const signed = store.signed(event, options.secret ?? WEBHOOK_SECRET, options.at ?? clock());
  const raw = signed.rawBody.toString('utf8');
  const response = await fetch(
    `${slice.baseUrl}/v1/integrations/commerce/${options.merchant ?? merchantId}/webhook`,
    { method: 'POST', headers: signed.headers, body: options.body ? options.body(raw) : raw },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function deliverAll(events: StripeEvent[]) {
  for (const event of events) expect((await deliver(event)).status).toBe(200);
}

const commerce = (conversationId: string, path: string) =>
  `/v1/widget/conversations/${conversationId}/commerce/${path}`;

async function newCustomer(firstMessage = 'Hello, I want to buy some stationery') {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { visitor, conversationId: started.body.id as string };
}

async function cartWith(
  visitor: Visitor,
  conversationId: string,
  lines: { productId: string; quantity: number }[],
  expectedRevision: number | null = null,
) {
  const cart = await visitor.call('POST', commerce(conversationId, 'cart'), {
    expectedRevision,
    lines: lines.map((l) => ({ ...l, variantId: null })),
  });
  expect(cart.status, JSON.stringify(cart.body)).toBe(200);
  return cart.body as { id: string; revision: number };
}

async function quoted(visitor: Visitor, conversationId: string, revision: number) {
  const quote = await visitor.call('POST', commerce(conversationId, 'cart/quote'), {
    cartRevision: revision,
  });
  expect(quote.status, JSON.stringify(quote.body)).toBe(201);
  return quote.body as {
    id: string;
    hash: string;
    status: string;
    document: QuoteDocument;
    intent: { id: string; outcome: string };
  };
}

function approve(
  visitor: Visitor,
  conversationId: string,
  quote: { id: string; hash: string; document: QuoteDocument },
  overrides: { quoteHash?: string; cartRevision?: number; clientRequestId?: string } = {},
) {
  return visitor.call('POST', commerce(conversationId, `quotes/${quote.id}/approve`), {
    quoteHash: overrides.quoteHash ?? quote.hash,
    cartRevision: overrides.cartRevision ?? quote.document.cart.revision,
    clientRequestId: overrides.clientRequestId ?? randomUUID(),
  });
}

async function paidOrder() {
  const { visitor, conversationId } = await newCustomer();
  const cart = await cartWith(visitor, conversationId, [
    { productId: 'prod_notebook', quantity: 1 },
  ]);
  const quote = await quoted(visitor, conversationId, cart.revision);
  const purchase = await approve(visitor, conversationId, quote);
  expect(purchase.status, JSON.stringify(purchase.body)).toBe(200);
  const session = await sessionOf(purchase.body.id);
  await deliverAll(store.pay(session));
  await settle();
  const done = await visitor.call('GET', commerce(conversationId, `purchases/${purchase.body.id}`));
  expect(done.body.outcome).toBe('paid');
  return { visitor, conversationId, purchase: done.body, quote };
}

async function sessionOf(purchasePublicId: string): Promise<string> {
  const [intent] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, fromPublicId('purchase', purchasePublicId))),
  );
  if (!intent?.checkoutSessionRef) throw new Error('no checkout session');
  return intent.checkoutSessionRef;
}

async function authorityMessages(conversationPublicId: string) {
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(
        eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
      ),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  return runtime.authority.listMessages(String(control.externalConversationId), { view: 'staff' });
}

/** Makes every commerce check due now (the worker leases by the database clock). */
async function makeChecksDue() {
  await withTenant(slice.app, { tenantId }, async (tx) => {
    await tx
      .update(schema.operations)
      .set({
        nextReconcileAt: sql`now() - interval '1 second'`,
        dispatchedAt: sql`now() - interval '1 minute'`,
      })
      .where(sql`${schema.operations.state} in ('dispatched', 'unknown')`);
    await tx
      .update(schema.payments)
      .set({ nextSyncAt: sql`now() - interval '1 second'` })
      .where(sql`${schema.payments.nextSyncAt} is not null`);
    await tx
      .update(schema.refunds)
      .set({ nextSyncAt: sql`now() - interval '1 second'` })
      .where(sql`${schema.refunds.nextSyncAt} is not null`);
  });
}

beforeAll(async () => {
  fakeStripe = await startFakeStripe();
  slice = await startSlice({
    clock,
    model,
    env: { COMMERCE_STRIPE_API_BASE: fakeStripe.url, COMMERCE_PROVIDER_TIMEOUT_MS: '1500' },
  });
  shop = await connectedTenant(slice, 'north');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const list = await shop.owner.get('/v1/admin/roles');
  roles = Object.fromEntries(
    list.body.items.map((r: { key: string; id: string }) => [r.key, r.id]),
  );
  store = MockCommerceStore.get(STORE_ID);
  store.clock = clock;
}, 180_000);

afterAll(async () => {
  MockCommerceStore.reset(STORE_ID);
  await slice?.close();
  await fakeStripe?.close();
});

describe('merchant connection (C01, E02)', () => {
  it('needs two-step verification, keeps credentials write-only and publishes capabilities', async () => {
    const input = {
      brandId: shop.brand.id,
      provider: 'mock',
      displayName: 'Northline Store',
      currencies: ['AED'],
      shipping: { amountMinor: '1000', label: 'Delivery' },
      refundPolicy: { approval: 'always', requireSeparateApprover: true },
      terms: { refundSummary: 'Refunds within 14 days of delivery.' },
      quoteMinutes: 10,
      webhookSecret: WEBHOOK_SECRET,
      mockStoreId: STORE_ID,
    };
    const denied = await shop.owner.post('/v1/admin/commerce/merchants', input);
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('MFA_REQUIRED');
    admin = await mfaClient(shop.owner, 'north-owner@example.com');

    const created = await admin.post('/v1/admin/commerce/merchants', input, {
      headers: { 'idempotency-key': 'merchant-north-1' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    merchantId = created.body.id;
    expect(created.body).toMatchObject({
      provider: 'mock',
      status: 'active',
      currencies: ['AED'],
      credentials: { apiKey: null, webhookSecret: '••••cdef' },
      webhookUrl: `${slice.baseUrl}/v1/integrations/commerce/${merchantId}/webhook`,
    });
    expect(created.body.capabilities).toMatchObject({
      version: 1,
      checkout: { hosted: true },
      refunds: { full: true, partial: true },
      recurring: false,
    });
    expect(JSON.stringify(created.body)).not.toContain(WEBHOOK_SECRET);
    const replay = await admin.post('/v1/admin/commerce/merchants', input, {
      headers: { 'idempotency-key': 'merchant-north-1' },
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(merchantId);
    const second = await admin.post('/v1/admin/commerce/merchants', input);
    expect(second.status).toBe(409);

    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'commerce.merchant.connected')),
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.data)).not.toContain(WEBHOOK_SECRET);
  });
});

describe('quote → approval → hosted checkout → webhook → receipt (C02–C08, C10, X10)', () => {
  let flow: { visitor: Visitor; conversationId: string };
  let purchaseId: string;
  let paidEvents: StripeEvent[];

  it('shows live products, keeps an exact quote and binds approval to its hash', async () => {
    flow = await newCustomer();
    const { visitor, conversationId } = flow;
    const catalog = await visitor.call('POST', commerce(conversationId, 'catalogs'), {});
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(201);
    expect(catalog.headers.get('cache-control')).toBe('no-store');
    expect(catalog.body.items.map((i: { productId: string }) => i.productId)).toEqual([
      'prod_notebook',
      'prod_pens',
      'prod_planner',
    ]);
    expect(catalog.body.items[2]).toMatchObject({ availability: 'out_of_stock', stockQuantity: 0 });

    const cart = await visitor.call('POST', commerce(conversationId, 'cart'), {
      expectedRevision: null,
      catalogId: catalog.body.snapshotId,
      lines: [
        { productId: 'prod_notebook', variantId: null, quantity: 2 },
        { productId: 'prod_pens', variantId: null, quantity: 1 },
      ],
    });
    expect(cart.status, JSON.stringify(cart.body)).toBe(200);
    expect(cart.body).toMatchObject({ revision: 1, itemCount: 3, estimatedSubtotalMinor: '8500' });
    const stale = await visitor.call('POST', commerce(conversationId, 'cart'), {
      expectedRevision: null,
      lines: [],
    });
    expect(stale.status).toBe(409);

    const quote = await quoted(visitor, conversationId, 1);
    expect(quote.status).toBe('ready');
    expect(quote.document).toMatchObject({
      currency: 'AED',
      subtotalMinor: '8500',
      shippingMinor: '1000',
      totalMinor: '9500',
      merchant: { name: 'Northline Store' },
    });
    // The widget recomputes the hash from the document before it enables "Approve".
    expect(quoteHash(quote.document)).toBe(quote.hash);
    expect(quote.intent.outcome).toBe('awaiting_approval');

    const clientRequestId = randomUUID();
    const purchase = await approve(visitor, conversationId, quote, { clientRequestId });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(200);
    expect(purchase.body).toMatchObject({ outcome: 'awaiting_payment', state: 'executing' });
    expect(purchase.body.checkout.url).toMatch(/^https:\/\/checkout\.mock\.hamnivo\.test\/pay\//);
    expect(purchase.body.order.reference).toMatch(/^HV-[0-9A-Z]{6}$/);
    purchaseId = purchase.body.id;
    // A repeated tap is the same purchase: no second payment page.
    const again = await approve(visitor, conversationId, quote, { clientRequestId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(purchaseId);
    expect(store.countCalls('createCheckout')).toBe(1);
    // The approved quote cannot be approved again under another request id.
    expect((await approve(visitor, conversationId, quote)).status).toBe(409);
  });

  it('says "confirming", never "paid", while the bank has not confirmed (HNV-20-05)', async () => {
    const { visitor, conversationId } = flow;
    const session = await sessionOf(purchaseId);
    // A bank payment: the page completes, the money is confirmed later.
    paidEvents = store.pay(session, { async: true });
    // The browser came back from the payment page; "Check status" asks the provider.
    const refreshed = await visitor.call(
      'POST',
      commerce(conversationId, `purchases/${purchaseId}/refresh`),
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get('cache-control')).toBe('no-store');
    expect(refreshed.body).toMatchObject({
      outcome: 'confirming',
      payment: { state: 'processing' },
    });
    const findsBefore = store.countCalls('getCheckout');
    // Asked again at once: answered from the records, the provider is not asked twice.
    await visitor.call('POST', commerce(conversationId, `purchases/${purchaseId}/refresh`));
    expect(store.countCalls('getCheckout')).toBe(findsBefore);
    paidEvents.push(...store.settleAsync(session, 'succeeded'));
  });

  it('applies the signed webhook once and posts a receipt card', async () => {
    const { visitor, conversationId } = flow;
    await deliverAll(paidEvents);
    await settle();
    const done = await visitor.call('GET', commerce(conversationId, `purchases/${purchaseId}`));
    expect(done.body).toMatchObject({
      outcome: 'paid',
      state: 'completed',
      payment: { state: 'captured', amountMinor: '9500', currency: 'AED' },
    });
    const order = await visitor.call(
      'GET',
      commerce(conversationId, `orders/${done.body.order.id}`),
    );
    expect(order.body).toMatchObject({
      state: 'confirmed',
      paymentState: 'captured',
      totalMinor: '9500',
    });

    const receipts = await withTenant(slice.app, { tenantId }, async (tx) => {
      const [intent] = await tx
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.id, fromPublicId('purchase', purchaseId)));
      return tx
        .select()
        .from(schema.operationReceipts)
        .where(eq(schema.operationReceipts.operationId, intent?.checkoutOperationId ?? ''))
        .orderBy(asc(schema.operationReceipts.createdAt));
    });
    expect(receipts.map((r) => [r.kind, r.outcome, r.source, r.evidence.subject])).toEqual([
      ['dispatch', 'pending', 'provider_api', 'checkout_session'],
      ['response', 'succeeded', 'provider_api', 'checkout_session'],
      ['reconcile', 'pending', 'provider_api', 'payment'],
      ['webhook', 'succeeded', 'provider_webhook', 'payment'],
    ]);

    // Cards are Hamnivo records referenced from Chatwoot messages, with a text fallback.
    const messages = await authorityMessages(conversationId);
    const cards = messages.filter((m) => m.key?.startsWith('hv1:c:'));
    expect(
      cards.map((m) => (m.contentAttributes.hv as { card: { type: string } }).card.type),
    ).toEqual(['catalog', 'quote', 'receipt']);
    expect(cards.every((m) => m.sender.kind === 'bot' && !m.private)).toBe(true);
    expect(cards[1]?.text).toContain('Total AED 95.00');
    const history = await visitor.call(
      'GET',
      `/v1/widget/conversations/${conversationId}/messages`,
    );
    const parts = history.body.items.flatMap(
      (m: { parts: { type: string; card?: { kind: string } }[] }) =>
        m.parts.filter((p) => p.type === 'card').map((p) => p.card?.kind),
    );
    expect(parts).toEqual(expect.arrayContaining(['catalog', 'quote', 'receipt']));
    const quoteMessage = history.body.items.find((m: { parts: { card?: { kind: string } }[] }) =>
      m.parts.some((p) => p.card?.kind === 'quote'),
    );
    expect(quoteMessage.sender).toEqual({ kind: 'system', displayName: 'Northline Store' });
  });

  it('applies a replayed webhook once (C08)', async () => {
    const before = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.operationReceipts),
    );
    await deliverAll(paidEvents);
    await settle();
    const after = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.operationReceipts),
    );
    expect(after.length).toBe(before.length);
    const events = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.commerceEvents),
    );
    const stored = events.filter((e) => paidEvents.some((p) => p.id === e.providerEventId));
    expect(stored).toHaveLength(paidEvents.length);
    // Stored once and processed once: the replay was acknowledged without being queued again.
    expect(stored.map((e) => e.attempts)).toEqual(paidEvents.map(() => 1));
    const receiptCards = (await authorityMessages(flow.conversationId)).filter(
      (m) =>
        (m.contentAttributes.hv as { card?: { type: string } } | undefined)?.card?.type ===
        'receipt',
    );
    expect(receiptCards).toHaveLength(1);
  });

  it('refuses unsigned, tampered, stale and foreign-secret deliveries', async () => {
    const event = paidEvents[0] as StripeEvent;
    const tampered = await deliver(event, {
      body: (raw) => raw.replace('"livemode":false', '"livemode":true'),
    });
    expect(tampered.status).toBe(401);
    const stale = await deliver(event, { at: new Date(clock().getTime() - 10 * 60_000) });
    expect(stale.status).toBe(401);
    expect(stale.body.detail).toBe('Stale webhook timestamp.');
    const foreign = await deliver(event, { secret: 'whsec_someone_else_0123456789' });
    expect(foreign.status).toBe(401);
    const unsigned = await fetch(
      `${slice.baseUrl}/v1/integrations/commerce/${merchantId}/webhook`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      },
    );
    expect(unsigned.status).toBe(401);
  });

  it('ignores a late "expired" event for a paid session (out of order)', async () => {
    const session = await sessionOf(purchaseId);
    const late: StripeEvent = {
      id: `evt_late_${randomUUID().slice(0, 8)}`,
      type: 'checkout.session.expired',
      created: Math.floor(clock().getTime() / 1000),
      livemode: false,
      account: store.accountId,
      data: { object: { ...store.sessions.get(session), status: 'expired', url: null } },
    };
    expect((await deliver(late)).status).toBe(200);
    await settle();
    const [event] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.commerceEvents)
        .where(eq(schema.commerceEvents.providerEventId, late.id)),
    );
    expect(event?.outcome).toBe('stale');
    const purchase = await flow.visitor.call(
      'GET',
      commerce(flow.conversationId, `purchases/${purchaseId}`),
    );
    expect(purchase.body.outcome).toBe('paid');
  });
});

describe('approval binding (C04)', () => {
  it('invalidates the approval when the cart changes', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    await cartWith(
      visitor,
      conversationId,
      [{ productId: 'prod_pens', quantity: 2 }],
      cart.revision,
    );
    const refused = await approve(visitor, conversationId, quote);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('APPROVAL_MISMATCH');
    const view = await visitor.call('GET', commerce(conversationId, `quotes/${quote.id}`));
    expect(view.body.status).toBe('superseded');
    expect(store.countCalls('createCheckout')).toBe(1);
  });

  it('refuses a hash or cart revision other than the one shown', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const otherHash = await approve(visitor, conversationId, quote, { quoteHash: 'a'.repeat(64) });
    expect(otherHash.status).toBe(409);
    expect(otherHash.body.code).toBe('APPROVAL_MISMATCH');
    const otherRevision = await approve(visitor, conversationId, quote, { cartRevision: 7 });
    expect(otherRevision.status).toBe(409);
    // Another customer cannot approve it, nor learn that it exists.
    const stranger = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await stranger.open();
    const foreign = await approve(stranger, conversationId, quote);
    expect(foreign.status).toBe(404);
    expect((await stranger.call('POST', commerce(conversationId, 'catalogs'), {})).status).toBe(
      404,
    );
    expect((await stranger.call('GET', commerce(conversationId, 'cart'))).status).toBe(404);
    // Staff and the AI have no approval path: the widget session of that customer is required.
    const staff = await admin.post(commerce(conversationId, `quotes/${quote.id}/approve`), {
      quoteHash: quote.hash,
      cartRevision: cart.revision,
      clientRequestId: randomUUID(),
    });
    expect(staff.status).toBe(401);
    expect((await approve(visitor, conversationId, quote)).status).toBe(200);
  });

  it('cannot approve an expired quote', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [
      { productId: 'prod_notebook', quantity: 1 },
    ]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const calls = store.countCalls('createCheckout');
    offsetMs = 11 * 60_000;
    try {
      const view = await visitor.call('GET', commerce(conversationId, `quotes/${quote.id}`));
      expect(view.body.status).toBe('expired');
      const refused = await approve(visitor, conversationId, quote);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('QUOTE_EXPIRED');
      expect(store.countCalls('createCheckout')).toBe(calls);
      const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .select()
          .from(schema.quotes)
          .where(eq(schema.quotes.id, fromPublicId('quote', quote.id))),
      );
      expect(row?.status).toBe('expired');
    } finally {
      offsetMs = 0;
    }
  });

  it('charges the approved price even if the catalog price changes afterwards (K06, E12)', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    store.setPrice('prod_pens', 1800n);
    try {
      const purchase = await approve(visitor, conversationId, quote);
      expect(purchase.status).toBe(200);
      const session = store.sessions.get(await sessionOf(purchase.body.id));
      expect(session?.amount_total).toBe(2500);
      // A new quote reads the price live: never a cached one.
      const next = await newCustomer();
      const nextCart = await cartWith(next.visitor, next.conversationId, [
        { productId: 'prod_pens', quantity: 1 },
      ]);
      const fresh = await quoted(next.visitor, next.conversationId, nextCart.revision);
      expect(fresh.document.totalMinor).toBe('2800');
    } finally {
      store.setPrice('prod_pens', 1500n);
    }
  });
});

describe('unknown outcomes are reconciled, never repeated blindly (C07, C09, R07, X13)', () => {
  it('ends a timeout after provider success as unknown and reconciles it to paid with one charge', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [
      { productId: 'prod_notebook', quantity: 1 },
    ]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const sessionsBefore = store.sessions.size;
    const chargesBefore = store.charges;
    store.inject('createCheckout', 'timeout_after');
    const clientRequestId = randomUUID();
    const purchase = await approve(visitor, conversationId, quote, { clientRequestId });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(200);
    expect(purchase.body).toMatchObject({
      state: 'unknown',
      outcome: 'preparing_checkout',
      checkout: null,
    });
    expect(store.sessions.size).toBe(sessionsBefore + 1);
    // Tapping again does not create a second payment page.
    const again = await approve(visitor, conversationId, quote, { clientRequestId });
    expect(again.body.state).toBe('unknown');
    expect(store.sessions.size).toBe(sessionsBefore + 1);

    // A person takes over while the outcome is unknown: the operation stays visible (R07).
    const takeover = await admin.post(`/v1/conversations/${conversationId}/takeover`, {});
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    const inFlight = await admin.get(`/v1/conversations/${conversationId}/commerce`);
    expect(inFlight.status).toBe(200);
    expect(inFlight.body.inFlight).toEqual([
      expect.objectContaining({
        kind: 'commerce.checkout.create',
        state: 'unknown',
        actor: 'customer',
      }),
    ]);

    await makeChecksDue();
    await settle();
    const found = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(found.body).toMatchObject({ state: 'executing', outcome: 'awaiting_payment' });
    expect(found.body.checkout.url).toBeTruthy();
    expect(store.countCalls('findCheckout')).toBeGreaterThan(0);

    await deliverAll(store.pay(await sessionOf(purchase.body.id)));
    await settle();
    const paid = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(paid.body.outcome).toBe('paid');
    expect(store.sessions.size).toBe(sessionsBefore + 1);
    expect(store.charges).toBe(chargesBefore + 1);
    const after = await admin.get(`/v1/conversations/${conversationId}/commerce`);
    expect(after.body.inFlight).toEqual([]);
    expect(after.body.orders).toEqual([expect.objectContaining({ paymentState: 'captured' })]);
  });

  it('resends a request that never arrived under the same idempotency key: one session', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const sessionsBefore = store.sessions.size;
    const calls = store.countCalls('createCheckout');
    store.inject('createCheckout', 'timeout_before');
    const purchase = await approve(visitor, conversationId, quote);
    expect(purchase.body.state).toBe('unknown');
    expect(store.sessions.size).toBe(sessionsBefore);
    await makeChecksDue();
    await settle();
    const found = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(found.body.outcome).toBe('awaiting_payment');
    expect(store.countCalls('createCheckout')).toBe(calls + 2);
    expect(store.sessions.size).toBe(sessionsBefore + 1);
    const [op] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.resourceId, fromPublicId('purchase', purchase.body.id))),
    );
    expect(op).toMatchObject({ state: 'succeeded', attempts: 2 });
  });

  it('does not resend a lost checkout too late to be paid; nothing is charged and the cart is kept', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const sessionsBefore = store.sessions.size;
    store.inject('createCheckout', 'timeout_before');
    const purchase = await approve(visitor, conversationId, quote);
    expect(purchase.body.state).toBe('unknown');
    const sendsBefore = store.countCalls('createCheckout');
    // The stored request would now open a page that closes in 10 minutes: too short to resend.
    await withTenant(slice.app, { tenantId }, async (tx) => {
      const where = eq(schema.operations.resourceId, fromPublicId('purchase', purchase.body.id));
      const [op] = await tx.select().from(schema.operations).where(where);
      const detail = structuredClone(op?.detail) as { request: { expiresAt: string } };
      detail.request.expiresAt = new Date(clock().getTime() + 10 * 60_000).toISOString();
      await tx.update(schema.operations).set({ detail }).where(where);
    });
    await makeChecksDue();
    await settle();
    expect(store.countCalls('createCheckout')).toBe(sendsBefore);
    expect(store.sessions.size).toBe(sessionsBefore);
    const failed = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(failed.body).toMatchObject({ outcome: 'failed', checkout: null });
    const kept = await visitor.call('GET', commerce(conversationId, 'cart'));
    expect(kept.body.cart).toMatchObject({ status: 'open' });
    const [op] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.resourceId, fromPublicId('purchase', purchase.body.id))),
    );
    expect(op).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('finds a lost webhook by asking the provider (payment sync)', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const purchase = await approve(visitor, conversationId, quote);
    store.pay(await sessionOf(purchase.body.id)); // events never delivered
    await makeChecksDue();
    await settle();
    const paid = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(paid.body.outcome).toBe('paid');
  });

  it('closes an unpaid page on cancel, keeps the cart, and never undoes a payment', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 2 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const purchase = await approve(visitor, conversationId, quote);
    const cancelled = await visitor.call(
      'POST',
      commerce(conversationId, `purchases/${purchase.body.id}/cancel`),
    );
    expect(cancelled.body).toMatchObject({ outcome: 'cancelled', state: 'cancelled' });
    const kept = await visitor.call('GET', commerce(conversationId, 'cart'));
    expect(kept.body.cart).toMatchObject({ status: 'open', itemCount: 2 });
    expect(kept.body.shop).toMatchObject({ name: 'Northline Store', currency: 'AED' });

    // Paid in the same moment the customer pressed cancel: the payment stands.
    const second = await quoted(visitor, conversationId, kept.body.cart.revision);
    const paying = await approve(visitor, conversationId, second);
    store.pay(await sessionOf(paying.body.id));
    const late = await visitor.call(
      'POST',
      commerce(conversationId, `purchases/${paying.body.id}/cancel`),
    );
    expect(late.body.outcome).toBe('paid');
  });
});

describe('refunds need approval and a separate approver (C12, C19)', () => {
  let orderId: string;
  let supervisor: Client;
  let finance: Client;
  let agent: Client;

  beforeAll(async () => {
    const paid = await paidOrder();
    orderId = paid.purchase.order.id;
    supervisor = await member('Sam Supervisor', 'sam@example.com', 'supervisor', true);
    finance = await member('Farah Finance', 'farah@example.com', 'finance', true);
    agent = await member('Ali Agent', 'ali@example.com', 'agent');
  }, 120_000);

  it('holds a refund for approval and refuses the requester as approver', async () => {
    const requested = await supervisor.post(`/v1/admin/commerce/orders/${orderId}/refunds`, {
      clientRequestId: randomUUID(),
      amountMinor: '3500',
      reason: 'damaged',
      lines: [{ lineId: 'l1', quantity: 1 }],
      note: 'Cover torn',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body).toMatchObject({
      state: 'awaiting_approval',
      amountMinor: '3500',
      approval: { required: true, canApprove: false, reason: 'same_person' },
    });
    const refundId = requested.body.id as string;
    const self = await supervisor.post(`/v1/admin/commerce/refunds/${refundId}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATE_APPROVER_REQUIRED');
    const denied = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.action, 'commerce.refund.approved'),
            eq(schema.auditEvents.outcome, 'denied'),
          ),
        ),
    );
    expect(denied).toHaveLength(1);
    expect(store.refunds.size).toBe(0);

    // An agent may ask for refunds but never approve them.
    const noRight = await agent.post(`/v1/admin/commerce/refunds/${refundId}/approve`, {});
    expect(noRight.status).toBe(403);
    expect(noRight.body.code).toBe('SCOPE_DENIED');

    const view = await finance.get(`/v1/admin/commerce/orders/${orderId}`);
    expect(view.body.refunds[0].approval).toEqual({
      required: true,
      canApprove: true,
      reason: null,
    });
    const approved = await finance.post(`/v1/admin/commerce/refunds/${refundId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      state: 'pending',
      approvedBy: { name: 'Farah Finance' },
    });
    expect(store.refunds.size).toBe(1);

    // Not "refunded" until the provider says so.
    const customerView = await admin.get(`/v1/admin/commerce/orders/${orderId}`);
    expect(customerView.body.payment.refundedMinor).toBe('0');
    const providerRefund = [...store.refunds.values()][0];
    await deliverAll([store.settleRefund(providerRefund?.id ?? '', 'succeeded')]);
    await settle();
    const done = await finance.get(`/v1/admin/commerce/orders/${orderId}`);
    expect(done.body.refunds[0]).toMatchObject({ state: 'succeeded' });
    expect(done.body.payment.refundedMinor).toBe('3500');
    expect(done.body.order.refundedMinor).toBe('3500');

    const tooMuch = await supervisor.post(`/v1/admin/commerce/orders/${orderId}/refunds`, {
      clientRequestId: randomUUID(),
      amountMinor: '9000',
      reason: 'other',
    });
    expect(tooMuch.status).toBe(422);
  });

  it('records a refund whose answer was lost as unknown and finds it instead of refunding twice', async () => {
    const requested = await agent.post(`/v1/admin/commerce/orders/${orderId}/refunds`, {
      clientRequestId: randomUUID(),
      amountMinor: '1000',
      reason: 'customer_request',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    store.inject('createRefund', 'timeout_after');
    const approved = await finance.post(
      `/v1/admin/commerce/refunds/${requested.body.id}/approve`,
      {},
    );
    expect(approved.body.state).toBe('unknown');
    const refundsBefore = store.refunds.size;
    await makeChecksDue();
    await settle();
    const checked = await finance.post(
      `/v1/admin/commerce/refunds/${requested.body.id}/refresh`,
      {},
    );
    expect(checked.body.state).toBe('pending');
    expect(store.refunds.size).toBe(refundsBefore);
  });

  it('never resends a lost refund once the provider may have forgotten its key (C07)', async () => {
    const fresh = await paidOrder();
    const requested = await agent.post(
      `/v1/admin/commerce/orders/${fresh.purchase.order.id}/refunds`,
      { clientRequestId: randomUUID(), amountMinor: '700', reason: 'customer_request' },
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refundsBefore = store.refunds.size;
    // The request never reaches the provider, and the answer is a timeout.
    store.inject('createRefund', 'timeout_before');
    const approved = await finance.post(
      `/v1/admin/commerce/refunds/${requested.body.id}/approve`,
      {},
    );
    expect(approved.body.state).toBe('unknown');
    // A day later: past the provider's idempotency window (24 hours at Stripe).
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.operations)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(schema.operations.resourceId, fromPublicId('refund', requested.body.id))),
    );
    const sendsBefore = store.countCalls('createRefund');
    await makeChecksDue();
    await settle();
    // Looked up by its durable reference, not found, and not sent again.
    expect(store.countCalls('createRefund')).toBe(sendsBefore);
    expect(store.refunds.size).toBe(refundsBefore);
    const detail = await finance.get(`/v1/admin/commerce/orders/${fresh.purchase.order.id}`);
    expect(
      detail.body.refunds.find((r: { id: string }) => r.id === requested.body.id),
    ).toMatchObject({ state: 'unknown' });
    expect(detail.body.payment.refundedMinor).toBe('0');
    expect(detail.body.exceptions).toMatchObject([
      { kind: 'refund_unknown', state: 'open', nextSafeAction: 'check_status' },
    ]);
  });

  it('lists and resolves finance exceptions with a reason (audited, moves no money)', async () => {
    const fresh = await paidOrder();
    const requested = await agent.post(
      `/v1/admin/commerce/orders/${fresh.purchase.order.id}/refunds`,
      { clientRequestId: randomUUID(), amountMinor: '500', reason: 'customer_request' },
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const approved = await finance.post(
      `/v1/admin/commerce/refunds/${requested.body.id}/approve`,
      {},
    );
    const providerRef = approved.body.providerRef as string;
    await deliverAll([store.settleRefund(providerRef, 'failed')]);
    await settle();
    const list = await finance.get('/v1/admin/commerce/exceptions');
    expect(list.status).toBe(200);
    const failed = list.body.items.find((e: { kind: string }) => e.kind === 'refund_failed');
    expect(failed).toMatchObject({
      state: 'open',
      nextSafeAction: 'retry_refund',
      sourceState: 'failed',
    });
    const resolved = await finance.post(`/v1/admin/commerce/exceptions/${failed.id}/resolve`, {
      resolution: 'refunded_elsewhere',
      note: 'Refunded by bank transfer',
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({ state: 'resolved', resolution: 'refunded_elsewhere' });
    const noRight = await agent.post(`/v1/admin/commerce/exceptions/${failed.id}/resolve`, {
      resolution: 'written_off',
      note: 'x',
    });
    expect(noRight.status).toBe(403);
  });
});

describe('payment challenge resume (C06)', () => {
  it('resumes the same purchase on the same page after a bank challenge, with one charge', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [
      { productId: 'prod_notebook', quantity: 1 },
    ]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const approved = await approve(visitor, conversationId, quote);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const purchaseId = approved.body.id as string;
    const session = await sessionOf(purchaseId);
    const sessionsBefore = store.countCalls('createCheckout');

    // The bank asks the customer to confirm; they leave the page before doing it.
    const challenged = store.challenge(session);
    await deliverAll(challenged);
    await settle();
    const waiting = await visitor.call('GET', commerce(conversationId, `purchases/${purchaseId}`));
    expect(waiting.body).toMatchObject({
      outcome: 'awaiting_payment',
      payment: { state: 'requires_action' },
      checkout: { url: approved.body.checkout.url },
    });
    // The same event again changes nothing.
    await deliverAll(challenged);
    await settle();

    // Back in the chat, another tap does not start a second purchase or payment page.
    const again = await approve(visitor, conversationId, quote);
    expect(again.status).toBe(409);
    expect(store.countCalls('createCheckout')).toBe(sessionsBefore);

    // They confirm with the bank on the same page, and the purchase completes once.
    await deliverAll(store.pay(session));
    await settle();
    const done = await visitor.call('GET', commerce(conversationId, `purchases/${purchaseId}`));
    expect(done.body).toMatchObject({ outcome: 'paid', payment: { state: 'captured' } });
    expect([...store.payments.values()].filter((p) => p.sessionId === session)).toHaveLength(1);
    const receipts = await withTenant(slice.app, { tenantId }, async (tx) => {
      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.purchaseIntentId, fromPublicId('purchase', purchaseId)));
      const [intent] = await tx
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.id, fromPublicId('purchase', purchaseId)));
      return {
        payment,
        rows: await tx
          .select()
          .from(schema.operationReceipts)
          .where(eq(schema.operationReceipts.operationId, intent?.checkoutOperationId ?? ''))
          .orderBy(asc(schema.operationReceipts.createdAt)),
      };
    });
    expect(receipts.payment?.paymentRef).toBe(challenged[0]?.data.object.id);
    expect(
      receipts.rows
        .filter((r) => r.evidence.subject === 'payment')
        .map((r) => [r.kind, r.outcome, r.evidence.status ?? null]),
    ).toEqual([
      ['webhook', 'pending', 'requires_action'],
      ['webhook', 'succeeded', 'captured'],
    ]);
  });
});

describe('capability negotiation (E02)', () => {
  /** Changes the stored capability manifest, as a provider account without a feature would. */
  async function withCapabilities(change: (caps: Record<string, Record<string, unknown>>) => void) {
    await withTenant(slice.app, { tenantId }, async (tx) => {
      const id = fromPublicId('merchant', merchantId);
      const [row] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, id));
      const caps = structuredClone(row?.capabilities ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      change(caps);
      await tx
        .update(schema.merchantConnections)
        .set({ capabilities: caps })
        .where(eq(schema.merchantConnections.id, id));
    });
  }

  it('refuses a checkout the shop cannot do, before calling it, and keeps the cart', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [
      { productId: 'prod_notebook', quantity: 1 },
    ]);
    const sessionsBefore = store.sessions.size;
    await withCapabilities((caps) => {
      (caps.checkout as Record<string, unknown>).hosted = false;
    });
    try {
      const refused = await visitor.call('POST', commerce(conversationId, 'cart/quote'), {
        cartRevision: cart.revision,
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'CAPABILITY_UNSUPPORTED',
        detail: 'The shop does not support this in chat. Please contact the team.',
      });
      expect(store.sessions.size).toBe(sessionsBefore);
    } finally {
      await withCapabilities((caps) => {
        (caps.checkout as Record<string, unknown>).hosted = true;
      });
    }
    const kept = await visitor.call('GET', commerce(conversationId, 'cart'));
    expect(kept.body.cart).toMatchObject({ status: 'open', revision: cart.revision });
    const quote = await quoted(visitor, conversationId, cart.revision);
    expect(quote.status).toBe('ready');
  });

  it('offers the full refund when the shop cannot refund part of a payment', async () => {
    const paid = await paidOrder();
    const orderId = paid.purchase.order.id as string;
    await withCapabilities((caps) => {
      (caps.refunds as Record<string, unknown>).partial = false;
    });
    try {
      const partial = await admin.post(`/v1/admin/commerce/orders/${orderId}/refunds`, {
        clientRequestId: randomUUID(),
        amountMinor: '100',
        reason: 'customer_request',
      });
      expect(partial.status).toBe(422);
      expect(JSON.stringify(partial.body)).toContain('This shop can only refund the full amount.');
      const detail = await admin.get(`/v1/admin/commerce/orders/${orderId}`);
      expect(detail.body.refundable.partial).toBe(false);
      const full = await admin.post(`/v1/admin/commerce/orders/${orderId}/refunds`, {
        clientRequestId: randomUUID(),
        amountMinor: detail.body.refundable.maxMinor,
        reason: 'customer_request',
      });
      expect(full.status, JSON.stringify(full.body)).toBe(201);
      expect(full.body.state).toBe('awaiting_approval');
    } finally {
      await withCapabilities((caps) => {
        (caps.refunds as Record<string, unknown>).partial = true;
      });
    }
  });
});

describe('order and fulfilment lifecycle (C10, HNV-21-02)', () => {
  it('keeps paid, delayed, shipped and delivered distinct and tells the customer each step', async () => {
    const paid = await paidOrder();
    const orderId = paid.purchase.order.id as string;
    const reference = paid.purchase.order.reference as string;
    const lead = await member('Lina Lead', 'lina@example.com', 'supervisor');
    const helper = await member('Omar Agent', 'omar@example.com', 'agent');
    const fulfil = (who: Client, body: Record<string, unknown>) =>
      who.post(`/v1/admin/commerce/orders/${orderId}/fulfillments`, body);

    // Paid is not shipped: nothing has been sent yet.
    const before = await lead.get(`/v1/admin/commerce/orders/${orderId}`);
    expect(before.body.order).toMatchObject({
      state: 'confirmed',
      paymentState: 'captured',
      fulfillmentState: 'not_started',
    });
    expect(before.body.fulfillments).toEqual([]);

    // Agents can read orders but not record fulfilment.
    const noRight = await fulfil(helper, { kind: 'shipment', state: 'shipped' });
    expect(noRight.status).toBe(403);
    expect(noRight.body.code).toBe('SCOPE_DENIED');

    // A delay is its own state, with the merchant's estimate.
    const delayed = await fulfil(lead, {
      kind: 'shipment',
      state: 'delayed',
      estimateAt: '2026-10-05T09:00:00.000Z',
      note: 'Waiting for stock',
    });
    expect(delayed.status, JSON.stringify(delayed.body)).toBe(200);
    expect(delayed.body.order).toMatchObject({
      state: 'confirmed',
      paymentState: 'captured',
      fulfillmentState: 'delayed',
    });
    expect(delayed.body.fulfillments).toMatchObject([
      {
        kind: 'shipment',
        state: 'delayed',
        source: 'staff',
        estimateAt: '2026-10-05T09:00:00.000Z',
        note: 'Waiting for stock',
      },
    ]);

    const shipped = await fulfil(lead, { kind: 'shipment', state: 'shipped', carrierRef: 'TRK-1' });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(shipped.body.order).toMatchObject({ state: 'confirmed', fulfillmentState: 'shipped' });
    expect(shipped.body.fulfillments).toMatchObject([
      { state: 'shipped', carrierRef: 'TRK-1', estimateAt: '2026-10-05T09:00:00.000Z' },
    ]);

    // A shipment cannot become an activated service.
    const wrong = await fulfil(lead, { kind: 'shipment', state: 'provisioned' });
    expect(wrong.status).toBe(409);

    const delivered = await fulfil(lead, { kind: 'shipment', state: 'delivered' });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.order).toMatchObject({
      state: 'fulfilled',
      paymentState: 'captured',
      fulfillmentState: 'delivered',
    });
    expect(delivered.body.fulfillments).toHaveLength(1);

    // The customer sees the same states, and each step was posted to the chat as a card.
    const customer = await paid.visitor.call(
      'GET',
      commerce(paid.conversationId, `orders/${orderId}`),
    );
    expect(customer.body).toMatchObject({
      state: 'fulfilled',
      paymentState: 'captured',
      fulfillmentState: 'delivered',
    });
    await settle();
    const statusCards = (await authorityMessages(paid.conversationId)).filter(
      (m) =>
        m.key?.startsWith('hv1:c:') &&
        (m.contentAttributes.hv as { card: { type: string } }).card.type === 'order_status',
    );
    const notGuaranteed = "The shop's estimate: 2026-10-05. This date is not guaranteed.";
    expect(statusCards.map((m) => m.text)).toEqual([
      `Order ${reference} is delayed. ${notGuaranteed}`,
      `Order ${reference} has shipped. ${notGuaranteed}`,
      `Order ${reference} was delivered.`,
    ]);
    const history = await paid.visitor.call(
      'GET',
      `/v1/widget/conversations/${paid.conversationId}/messages`,
    );
    const shown = history.body.items.flatMap(
      (m: { parts: { type: string; card?: { kind: string } }[] }) =>
        m.parts.flatMap((p) => (p.card?.kind === 'order_status' ? [p.card] : [])),
    );
    // Newest first in the widget history.
    expect([...shown].reverse()).toMatchObject([
      { fulfillmentState: 'delayed', paymentState: 'paid', estimateAt: '2026-10-05T09:00:00.000Z' },
      { fulfillmentState: 'shipped', estimateAt: '2026-10-05T09:00:00.000Z' },
      { fulfillmentState: 'fulfilled', estimateAt: null },
    ]);

    const audited = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'commerce.fulfillment.recorded'))
        .orderBy(asc(schema.auditEvents.occurredAt)),
    );
    expect(audited.map((a) => (a.data as { state: string }).state)).toEqual([
      'delayed',
      'shipped',
      'delivered',
    ]);
  });

  it('does not fulfil an order that is not paid', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [
      { productId: 'prod_notebook', quantity: 1 },
    ]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    const purchase = await approve(visitor, conversationId, quote);
    expect(purchase.body.order.id).toBeTruthy();
    const unpaid = await shop.owner.post(
      `/v1/admin/commerce/orders/${purchase.body.order.id}/fulfillments`,
      { kind: 'shipment', state: 'shipped' },
    );
    expect(unpaid.status).toBe(422);
  });
});

describe('tenant isolation (cross-tenant denial)', () => {
  it('hides one tenant’s orders, carts and webhooks from another', async () => {
    const paid = await paidOrder();
    const other = await connectedTenant(slice, 'south', { publishAgent: false });
    const orderId = paid.purchase.order.id as string;
    expect((await other.owner.get(`/v1/admin/commerce/orders/${orderId}`)).status).toBe(404);
    const withForeignHeader = await other.owner.get(`/v1/admin/commerce/orders/${orderId}`, {
      tenant: shop.tenantId,
    });
    expect(withForeignHeader.status).toBe(404);
    expect((await other.owner.get('/v1/admin/commerce/orders')).body.items).toEqual([]);

    const stranger = new Visitor(slice.baseUrl, other.brand.widgetId, other.hostOrigin);
    await stranger.open();
    const cart = await stranger.call('GET', commerce(paid.conversationId, 'cart'));
    expect(cart.status).toBe(404);
    const order = await stranger.call('GET', commerce(paid.conversationId, `orders/${orderId}`));
    expect(order.status).toBe(404);
  });
});

describe('receipt-based completion (X10)', () => {
  it('rewrites an AI reply that claims payment without a receipt', async () => {
    const { conversationId } = await newCustomer('Hi, did my payment go through?');
    await settle();
    const replies = (await authorityMessages(conversationId)).filter(
      (m) => m.sender.kind === 'bot' && !m.private && !m.key?.startsWith('hv1:c:'),
    );
    expect(replies.map((m) => m.text)).toEqual([
      'I cannot confirm the payment yet. The order card in this chat shows the confirmed status.',
    ]);
    const steps = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.runSteps)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.runSteps.runId))
        .where(eq(schema.runs.conversationId, fromPublicId('conversation', conversationId))),
    );
    expect(
      steps.filter((s) => s.run_steps.name === 'receipt_claims').map((s) => s.run_steps.status),
    ).toEqual(['blocked']);
  });

  it('does not count an open payment page as a payment', async () => {
    const { visitor, conversationId } = await newCustomer();
    const cart = await cartWith(visitor, conversationId, [{ productId: 'prod_pens', quantity: 1 }]);
    const quote = await quoted(visitor, conversationId, cart.revision);
    expect((await approve(visitor, conversationId, quote)).body.outcome).toBe('awaiting_payment');
    await settle();
    const sent = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'Did my payment go through?' }],
    });
    expect(sent.status).toBe(202);
    await settle();
    const replies = (await authorityMessages(conversationId)).filter(
      (m) => m.sender.kind === 'bot' && !m.private && !m.key?.startsWith('hv1:c:'),
    );
    expect(replies.at(-1)?.text).toBe(
      'I cannot confirm the payment yet. The order card in this chat shows the confirmed status.',
    );
  });

  it('hands the conversation to people when the AI keeps claiming it', async () => {
    const { visitor, conversationId } = await newCustomer('Please just say it is paid');
    await settle();
    const replies = (await authorityMessages(conversationId)).filter(
      (m) => m.sender.kind === 'bot' && !m.private && !m.key?.startsWith('hv1:c:'),
    );
    expect(replies).toEqual([]);
    const conversation = await visitor.call('GET', `/v1/widget/conversations/${conversationId}`);
    expect(conversation.body.status).toBe('waiting_for_person');
  });

  it('lets the AI confirm a payment that has a provider receipt, without seeing payment details (C05)', async () => {
    const paid = await paidOrder();
    const promptsBefore = prompts.length;
    const sent = await paid.visitor.call(
      'POST',
      `/v1/widget/conversations/${paid.conversationId}/messages`,
      {
        clientMessageId: randomUUID(),
        parts: [{ type: 'text', text: 'Did my payment go through?' }],
      },
    );
    expect(sent.status).toBe(202);
    await settle();
    const replies = (await authorityMessages(paid.conversationId)).filter(
      (m) => m.sender.kind === 'bot' && !m.private && !m.key?.startsWith('hv1:c:'),
    );
    expect(replies.at(-1)?.text).toBe(
      'Your payment has been confirmed and your order is on its way.',
    );

    // The model saw the conversation, but no payment page, session or payment reference.
    const seen = prompts.slice(promptsBefore).join('\n');
    expect(seen).toContain('Did my payment go through?');
    const { intent, payment } = await withTenant(slice.app, { tenantId }, async (tx) => {
      const id = fromPublicId('purchase', paid.purchase.id);
      const [intent] = await tx
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.id, id));
      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.purchaseIntentId, id));
      return { intent, payment };
    });
    for (const secret of [
      intent?.checkoutSessionRef,
      intent?.checkoutUrl,
      payment?.paymentRef,
      payment?.sessionRef,
    ]) {
      expect(secret).toBeTruthy();
      expect(seen).not.toContain(secret);
    }
    expect(seen).not.toMatch(/\b(cs|pi)_[A-Za-z0-9]/);
  });
});

describe('Stripe adapter through the fake Stripe server (C05, C08)', () => {
  it('pays through a Stripe hosted session and confirms it from Stripe-signed webhooks', async () => {
    const east = await connectedTenant(slice, 'east');
    const eastTenant = fromPublicId('tenant', east.tenantId);
    const eastAdmin = await mfaClient(east.owner, 'east-owner@example.com');
    const created = await eastAdmin.post('/v1/admin/commerce/merchants', {
      brandId: east.brand.id,
      provider: 'stripe',
      displayName: 'East Stationers',
      currencies: ['AED'],
      apiKey: fakeStripe.apiKey,
      webhookSecret: 'whsec_east_fake_0123456789abcdef',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.credentials.apiKey).toBe(`••••${fakeStripe.apiKey.slice(-4)}`);
    expect(JSON.stringify(created.body)).not.toContain(fakeStripe.apiKey);
    fakeStripe.webhookEndpoints.push({
      url: created.body.webhookUrl,
      secret: 'whsec_east_fake_0123456789abcdef',
    });

    const visitor = new Visitor(slice.baseUrl, east.brand.widgetId, east.hostOrigin);
    await visitor.open();
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'I would like a notebook',
    });
    const conversationId = started.body.id as string;
    const catalog = await visitor.call('POST', commerce(conversationId, 'catalogs'), {
      query: 'notebook',
    });
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(201);
    expect(catalog.body.source).toBe('stripe:prices.list');
    const item = catalog.body.items[0];
    const cart = await visitor.call('POST', commerce(conversationId, 'cart'), {
      expectedRevision: null,
      lines: [{ productId: item.productId, variantId: item.variantId, quantity: 2 }],
    });
    expect(cart.status, JSON.stringify(cart.body)).toBe(200);
    const quote = await quoted(visitor, conversationId, cart.body.revision);
    expect(quote.document.totalMinor).toBe('7000');
    const purchase = await approve(visitor, conversationId, quote);
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(200);
    expect(purchase.body.outcome).toBe('awaiting_payment');
    const [intent] = await withTenant(slice.app, { tenantId: eastTenant }, (tx) =>
      tx
        .select()
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.id, fromPublicId('purchase', purchase.body.id))),
    );
    const sessionId = intent?.checkoutSessionRef ?? '';
    expect(fakeStripe.sessions.get(sessionId)?.amount_total).toBe(7000);
    await fakeStripe.pay(sessionId);
    await settle();
    const paid = await visitor.call(
      'GET',
      commerce(conversationId, `purchases/${purchase.body.id}`),
    );
    expect(paid.body).toMatchObject({
      outcome: 'paid',
      payment: { state: 'captured', amountMinor: '7000' },
    });
    // Every request to the provider carried an idempotency key where it writes.
    const writes = fakeStripe.requests.filter(
      (r) => r.method === 'POST' && r.path.startsWith('/v1/'),
    );
    expect(writes.every((r) => r.idempotencyKey?.startsWith('hv-'))).toBe(true);
  });
});
