import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockCommerceProvider, MockCommerceStore } from '../../src/commerce/index.js';
import { type CommerceKit, describeCommerceContract } from './contract.js';

const SECRET = 'whsec_mock_contract';

const mockKit: CommerceKit = {
  name: 'mock',
  async setup() {
    const id = `contract-${randomUUID()}`;
    const store = MockCommerceStore.get(id);
    const sign = (event: object, options: { secret?: string; at?: Date } = {}) =>
      store.signed(event as never, options.secret ?? SECRET, options.at);
    return {
      provider: new MockCommerceProvider(store),
      control: {
        webhookSecret: SECRET,
        async pay(sessionId) {
          return store.pay(sessionId).map((event) => sign(event));
        },
        async expire(sessionId) {
          return sign(store.expireSession(sessionId));
        },
        async settleRefund(refundId, outcome) {
          return sign(store.settleRefund(refundId, outcome));
        },
        loseAnswer(op) {
          store.inject(op, 'timeout_after');
        },
        dropRequest(op) {
          store.inject(op, 'timeout_before');
        },
        setPrice(productId, amountMinor) {
          store.setPrice(productId, amountMinor);
        },
        sessionCount: () => store.sessions.size,
        chargeCount: () => store.charges,
        sign,
      },
      async close() {
        MockCommerceStore.reset(id);
      },
    };
  },
};

describeCommerceContract(mockKit);

describe('mock provider specifics', () => {
  it('forgets idempotency keys after the retention window, as providers do', async () => {
    const store = MockCommerceStore.get(`window-${randomUUID()}`);
    let now = new Date('2026-09-27T10:00:00Z');
    store.clock = () => now;
    const provider = new MockCommerceProvider(store);
    const quote = await provider.quote({
      currency: 'AED',
      lines: [{ productId: 'prod_pens', variantId: null, quantity: 2 }],
    });
    const request = {
      reference: 'op_window',
      idempotencyKey: 'hv:op_window',
      quote,
      successUrl: 'https://widget.example/ok',
      cancelUrl: 'https://widget.example/cancel',
      expiresAt: new Date('2026-09-28T09:00:00Z'),
      metadata: {},
    };
    const first = await provider.createCheckout(request);
    now = new Date('2026-09-28T11:00:00Z');
    // Past the window the same key would create a new session: which is why Hamnivo's own ledger
    // resolves unknown outcomes by reference (findCheckout), never by re-sending (C07).
    const second = await provider.createCheckout(request);
    expect(second.id).not.toBe(first.id);
    expect((await provider.findCheckout('op_window', new Date('2026-09-27T09:00:00Z')))?.id).toBe(
      first.id,
    );
  });

  it('refuses a key reused for different parameters', async () => {
    const store = MockCommerceStore.get(`conflict-${randomUUID()}`);
    const provider = new MockCommerceProvider(store);
    const quote = await provider.quote({
      currency: 'AED',
      lines: [{ productId: 'prod_pens', variantId: null, quantity: 1 }],
    });
    const request = {
      reference: 'op_conflict',
      idempotencyKey: 'hv:op_conflict',
      quote,
      successUrl: 'https://widget.example/ok',
      cancelUrl: 'https://widget.example/cancel',
      expiresAt: new Date(Date.now() + 3600_000),
      metadata: {},
    };
    await provider.createCheckout(request);
    const other = { ...quote, totalMinor: quote.totalMinor + 100n };
    await expect(provider.createCheckout({ ...request, quote: other })).rejects.toMatchObject({
      kind: 'idempotency_conflict',
      mayHaveApplied: false,
    });
  });

  it('reports stock honestly and refuses to quote more than is in stock', async () => {
    const store = MockCommerceStore.get(`stock-${randomUUID()}`);
    const provider = new MockCommerceProvider(store);
    const planner = (await provider.searchCatalog({ text: 'planner', limit: 5 })).items[0];
    expect(planner).toMatchObject({ availability: 'out_of_stock', stockQuantity: 0 });
    await expect(
      provider.quote({
        currency: 'AED',
        lines: [{ productId: 'prod_planner', variantId: null, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ reason: 'out_of_stock' });
  });

  it('settles asynchronous payments later, successfully or not', async () => {
    const store = MockCommerceStore.get(`async-${randomUUID()}`);
    const provider = new MockCommerceProvider(store);
    const quote = await provider.quote({
      currency: 'AED',
      lines: [{ productId: 'prod_pens', variantId: null, quantity: 1 }],
    });
    const session = await provider.createCheckout({
      reference: 'op_async',
      idempotencyKey: 'hv:op_async',
      quote,
      successUrl: 'https://widget.example/ok',
      cancelUrl: 'https://widget.example/cancel',
      expiresAt: new Date(Date.now() + 3600_000),
      metadata: {},
    });
    const [completed] = store.pay(session.id, { async: true });
    expect(completed?.type).toBe('checkout.session.completed');
    expect((await provider.getCheckout(session.id)).paymentStatus).toBe('unpaid');
    expect(store.charges).toBe(0);
    const settled = store.settleAsync(session.id, 'succeeded');
    expect(settled.map((e) => e.type)).toEqual([
      'checkout.session.async_payment_succeeded',
      'payment_intent.succeeded',
    ]);
    expect(store.charges).toBe(1);
  });
});
