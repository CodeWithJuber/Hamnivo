import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CommerceApi, HamnivoApiError, HamnivoClient, MemoryStorage } from '../src/index.js';

const API = 'https://api.test';
const CONV = 'conv_01j9zk7w3xq8r4t2v6m5n1p0ce';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function api() {
  server.use(
    http.post(`${API}/v1/widget/sessions`, () =>
      HttpResponse.json(
        {
          accessToken: 'access',
          accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshToken: 'ses_x.refresh',
          principal: { id: 'cus_1', verified: false, displayName: null },
          config: {},
          conversations: [],
        },
        { status: 201 },
      ),
    ),
  );
  const client = new HamnivoClient({
    apiBase: API,
    widgetId: 'wid_test',
    storage: new MemoryStorage(),
  });
  return new CommerceApi(client);
}

describe('commerce calls', () => {
  it('replaces the cart with POST and the expected revision', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(`${API}/v1/widget/conversations/${CONV}/commerce/cart`, async ({ request }) => {
        seen.push(await request.json());
        expect(request.headers.get('authorization')).toBe('Bearer access');
        return HttpResponse.json({ id: 'cart_1', revision: 2 });
      }),
    );
    const cart = await api().updateCart(CONV, {
      expectedRevision: 1,
      lines: [{ productId: 'prod_pens', variantId: null, quantity: 2 }],
    });
    expect(cart.revision).toBe(2);
    expect(seen).toEqual([
      { expectedRevision: 1, lines: [{ productId: 'prod_pens', variantId: null, quantity: 2 }] },
    ]);
  });

  it('surfaces a stale cart and an expired quote as typed problems', async () => {
    server.use(
      http.post(`${API}/v1/widget/conversations/${CONV}/commerce/cart/quote`, () =>
        HttpResponse.json(
          { status: 409, code: 'VERSION_CONFLICT', retryable: false, title: 'x' },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      http.post(`${API}/v1/widget/conversations/${CONV}/commerce/quotes/quo_1/approve`, () =>
        HttpResponse.json(
          { status: 409, code: 'QUOTE_EXPIRED', retryable: false, title: 'x' },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const commerce = api();
    await expect(commerce.requestQuote(CONV, 3)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    const refused = await commerce
      .approve(CONV, 'quo_1', { quoteHash: 'a'.repeat(64), cartRevision: 3, clientRequestId: 'x' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HamnivoApiError);
    expect((refused as HamnivoApiError).code).toBe('QUOTE_EXPIRED');
  });

  it('asks the server, never a cache, for the purchase state', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/v1/widget/conversations/${CONV}/commerce/purchases/pur_1/refresh`, () => {
        calls += 1;
        return HttpResponse.json({ id: 'pur_1', outcome: calls === 1 ? 'confirming' : 'paid' });
      }),
    );
    const commerce = api();
    expect((await commerce.refreshPurchase(CONV, 'pur_1')).outcome).toBe('confirming');
    expect((await commerce.refreshPurchase(CONV, 'pur_1')).outcome).toBe('paid');
  });
});
