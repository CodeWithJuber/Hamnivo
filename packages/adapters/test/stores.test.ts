import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callShopify, callWooCommerce, SHOPIFY_API_VERSION } from '../src/stores/index.js';

/**
 * Fake Shopify and WooCommerce servers on this machine: the requests the adapters really send,
 * and what they make of the answers. The egress guard lets them through only because the test
 * trusts their origin, as a server administrator would.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let server: Server;
let origin: string;
const seen: Seen[] = [];
let answer: (request: Seen) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const entry = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      seen.push(entry);
      const { status, body: out } = answer(entry);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

const call = () => ({
  baseUrl: `${origin}/`,
  policy: { trustedOrigins: [origin] },
  timeoutMs: 3000,
});

describe('Shopify Admin GraphQL, read only', () => {
  it('sends a fixed orders query with the token in a header and returns its data', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { data: { orders: { nodes: [{ name: '#1001' }] } } } });
    const data = await callShopify({
      ...call(),
      token: 'shpat_secret',
      query: 'orders',
      search: 'email:"amina@example.com"',
      first: 50,
    });
    expect(data).toEqual({ orders: { nodes: [{ name: '#1001' }] } });
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(request?.headers['x-shopify-access-token']).toBe('shpat_secret');
    const body = JSON.parse(request?.body ?? '{}');
    expect(body.query).toMatch(/^query HamnivoOrders/);
    expect(body.query).not.toMatch(/mutation|shippingAddress|billingAddress|customer\s*\{/);
    // At most ten orders, whatever the caller asks.
    expect(body.variables).toEqual({ query: 'email:"amina@example.com"', first: 10 });
  });

  it('puts a refused token, throttling and errors in plain kinds, never the answer', async () => {
    answer = () => ({ status: 401, body: { errors: '[API] Invalid API key or access token' } });
    await expect(callShopify({ ...call(), token: 'x', query: 'shop' })).rejects.toMatchObject({
      kind: 'auth',
      message: 'The store could not be read.',
    });
    answer = () => ({
      status: 200,
      body: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] },
    });
    await expect(callShopify({ ...call(), token: 'x', query: 'shop' })).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    answer = () => ({
      status: 200,
      body: {
        errors: [{ message: 'Access denied for orders', extensions: { code: 'ACCESS_DENIED' } }],
      },
    });
    await expect(callShopify({ ...call(), token: 'x', query: 'shop' })).rejects.toMatchObject({
      kind: 'auth',
    });
    answer = () => ({ status: 404, body: 'Not Found' });
    await expect(callShopify({ ...call(), token: 'x', query: 'shop' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    answer = () => ({ status: 200, body: 'not json' });
    await expect(callShopify({ ...call(), token: 'x', query: 'shop' })).rejects.toMatchObject({
      kind: 'response',
    });
  });

  it('refuses another query, a path in the address, and an untrusted private host', async () => {
    seen.length = 0;
    await expect(
      callShopify({ ...call(), token: 'x', query: 'customers' as never }),
    ).rejects.toMatchObject({ kind: 'egress' });
    await expect(
      callShopify({ ...call(), baseUrl: `${origin}/admin`, token: 'x', query: 'shop' }),
    ).rejects.toMatchObject({ kind: 'egress' });
    await expect(
      callShopify({ ...call(), policy: {}, token: 'x', query: 'shop' }),
    ).rejects.toMatchObject({ kind: 'egress' });
    expect(seen).toHaveLength(0);
  });
});

describe('WooCommerce REST, read only', () => {
  it('searches orders with the key in Basic auth, newest first, ten at most', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: [{ id: 1048, number: '1048' }] });
    const rows = await callWooCommerce({
      ...call(),
      key: 'ck_key',
      secret: 'cs_secret',
      read: { kind: 'orders', search: 'sara@example.com', perPage: 99 },
    });
    expect(rows).toEqual([{ id: 1048, number: '1048' }]);
    const [request] = seen;
    expect(request?.method).toBe('GET');
    const url = new URL(request?.url ?? '/', origin);
    expect(url.pathname).toBe('/wp-json/wc/v3/orders');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      search: 'sara@example.com',
      per_page: '10',
      orderby: 'date',
      order: 'desc',
    });
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from('ck_key:cs_secret').toString('base64')}`,
    );
    // The key never travels in the address.
    expect(request?.url).not.toMatch(/ck_key|cs_secret/);
  });

  it('reads one order; a missing order is null, a site without WooCommerce is an error', async () => {
    answer = (request) =>
      request.url.startsWith('/wp-json/wc/v3/orders/7?')
        ? { status: 200, body: { id: 7, number: '7' } }
        : { status: 404, body: { code: 'woocommerce_rest_shop_order_invalid_id' } };
    const order = { ...call(), key: 'k', secret: 's' };
    expect(await callWooCommerce({ ...order, read: { kind: 'order', id: 7 } })).toEqual({
      id: 7,
      number: '7',
    });
    expect(await callWooCommerce({ ...order, read: { kind: 'order', id: 8 } })).toBeNull();
    answer = () => ({ status: 404, body: { code: 'rest_no_route' } });
    await expect(
      callWooCommerce({ ...order, read: { kind: 'order', id: 8 } }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(callWooCommerce({ ...order, read: { kind: 'check' } })).rejects.toMatchObject({
      kind: 'not_found',
    });
    answer = () => ({ status: 401, body: { code: 'woocommerce_rest_cannot_view' } });
    await expect(callWooCommerce({ ...order, read: { kind: 'check' } })).rejects.toMatchObject({
      kind: 'auth',
    });
    answer = () => ({ status: 200, body: { not: 'a list' } });
    await expect(callWooCommerce({ ...order, read: { kind: 'check' } })).rejects.toMatchObject({
      kind: 'response',
    });
    await expect(
      callWooCommerce({ ...order, read: { kind: 'order', id: -1 } }),
    ).rejects.toMatchObject({ kind: 'egress' });
  });

  it('says a store that is down is down', async () => {
    const closed = `http://127.0.0.1:9`;
    await expect(
      callWooCommerce({
        baseUrl: `${closed}/`,
        policy: { trustedOrigins: [closed] },
        timeoutMs: 2000,
        key: 'k',
        secret: 's',
        read: { kind: 'check' },
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});
