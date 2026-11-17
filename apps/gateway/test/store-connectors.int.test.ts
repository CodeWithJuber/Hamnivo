import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { EgressPolicy } from '@hamnivo/adapters/net';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, like } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolRow, ToolScope } from '../src/actions/adapters.js';
import { StoreTools } from '../src/connectors/store-tools.service.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Shopify and WooCommerce orders, read only (phase F), against fake stores on this machine. The
 * gateway's real adapters send real HTTP; only the address is swapped for the fake's, which the
 * egress guard then trusts as a server administrator would trust their own network.
 */
const fake = vi.hoisted(() => ({
  origin: '',
  down: false,
  /** The store addresses the gateway asked for, before the swap. */
  asked: [] as string[],
  seen: [] as { url: string; headers: Record<string, unknown>; body: string }[],
}));

vi.mock('@hamnivo/adapters/stores', async (original) => {
  const real = await original<typeof import('@hamnivo/adapters/stores')>();
  const swap = <T extends { baseUrl: string; policy: EgressPolicy }>(input: T): T => {
    fake.asked.push(input.baseUrl);
    const origin = fake.down ? 'http://127.0.0.1:9' : fake.origin;
    return {
      ...input,
      baseUrl: `${origin}/`,
      policy: { ...input.policy, trustedOrigins: [origin] },
    };
  };
  return {
    ...real,
    callShopify: (input: Parameters<typeof real.callShopify>[0]) => real.callShopify(swap(input)),
    callWooCommerce: (input: Parameters<typeof real.callWooCommerce>[0]) =>
      real.callWooCommerce(swap(input)),
  };
});

const shopifyOrders = [
  {
    name: '#1001',
    email: 'amina@example.com',
    createdAt: '2026-11-10T09:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    cancelledAt: null,
    currentSubtotalLineItemsQuantity: 2,
    currentTotalPriceSet: { shopMoney: { amount: '59.90', currencyCode: 'EUR' } },
    fulfillments: [{ trackingInfo: [{ company: 'DHL', number: 'JD014600', url: null }] }],
    shippingAddress: { address1: '1 Secret Street' },
  },
  {
    // The store's search is loose: this one also "matches" amina@example.com.
    name: '#1002',
    email: 'amina@example.com.elsewhere.example',
    createdAt: '2026-11-11T09:00:00Z',
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    currentSubtotalLineItemsQuantity: 1,
    currentTotalPriceSet: { shopMoney: { amount: '9.00', currencyCode: 'EUR' } },
    fulfillments: [],
  },
];
const wooOrders = [
  {
    id: 1048,
    number: '1048',
    status: 'processing',
    date_created_gmt: '2026-11-12T08:30:00',
    currency: 'GBP',
    total: '24.00',
    billing: { email: 'sara@example.com', address_1: '2 Hidden Road', phone: '+44 7700 900123' },
    line_items: [{ quantity: 3 }],
    meta_data: [],
  },
];

let server: Server;
function startFakeStores() {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', fake.origin);
      fake.seen.push({ url: url.pathname + url.search, headers: request.headers, body });
      const send = (status: number, json: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(json));
      };
      if (url.pathname.endsWith('/graphql.json')) {
        if (request.headers['x-shopify-access-token'] !== 'shpat_good') {
          return send(401, { errors: '[API] Invalid API key or access token' });
        }
        const { query, variables } = JSON.parse(body) as {
          query: string;
          variables: { query?: string };
        };
        if (query.includes('HamnivoShop')) return send(200, { data: { shop: { name: 'Noor' } } });
        const search = variables.query ?? '';
        const nodes = search.startsWith('email:')
          ? shopifyOrders.filter((o) => o.email.includes(search.slice(7, -1)))
          : shopifyOrders.filter((o) => search.includes(`"${o.name}"`));
        return send(200, { data: { orders: { nodes } } });
      }
      if (url.pathname.startsWith('/wp-json/wc/v3/orders')) {
        const auth = Buffer.from(
          String(request.headers.authorization ?? '').replace(/^Basic /, ''),
          'base64',
        ).toString();
        if (auth !== 'ck_good:cs_good') return send(401, { code: 'woocommerce_rest_cannot_view' });
        const id = /\/orders\/(\d+)$/.exec(url.pathname)?.[1];
        if (id) {
          const order = wooOrders.find((o) => o.id === Number(id));
          return order
            ? send(200, order)
            : send(404, { code: 'woocommerce_rest_shop_order_invalid_id' });
        }
        const search = url.searchParams.get('search');
        return send(
          200,
          search
            ? wooOrders.filter((o) => o.billing.email === search || o.number === search)
            : wooOrders.slice(0, 1),
        );
      }
      return send(404, { code: 'rest_no_route' });
    });
  });
  return new Promise<void>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') fake.origin = `http://127.0.0.1:${address.port}`;
      ok();
    });
  });
}

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let identityKey: { kid: string; privateKey: CryptoKey };

beforeAll(async () => {
  await startFakeStores();
  slice = await startSlice();
  shop = await connectedTenant(slice, 'stores');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  identityKey = { kid: `k-${randomUUID().slice(0, 8)}`, privateKey };
  const publicJwk = await exportJWK(publicKey);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.insert(schema.brandIdentityKeys).values({
      tenantId,
      brandId: fromPublicId('brand', shop.brand.id),
      kid: identityKey.kid,
      alg: 'ES256',
      publicJwk,
    }),
  );
});

afterAll(async () => {
  await slice?.close();
  await new Promise<void>((ok) => server?.close(() => ok()));
});

const connect = (body: Record<string, unknown>) =>
  shop.owner.post('/v1/admin/connectors', {
    brandId: shop.brand.id,
    capabilities: ['orders.read', 'order.status'],
    ...body,
  });

async function toolOf(prefix: string): Promise<ToolRow> {
  const [tool] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.toolDefinitions)
      .where(
        and(
          eq(schema.toolDefinitions.brandId, fromPublicId('brand', shop.brand.id)),
          like(schema.toolDefinitions.name, `${prefix}%`),
        ),
      ),
  );
  if (!tool) throw new Error(`no tool ${prefix}`);
  return tool;
}

async function customer(email?: string): Promise<string> {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  if (email) {
    const assertion = await new SignJWT({ name: 'Amina Noor', email, email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: identityKey.kid })
      .setSubject(`customer-${randomUUID().slice(0, 8)}`)
      .setAudience(shop.brand.widgetId)
      .setIssuedAt()
      .setExpirationTime('2m')
      .setJti(randomUUID())
      .sign(identityKey.privateKey);
    const identified = await visitor.call('POST', '/v1/widget/identity', { assertion });
    expect(identified.status, JSON.stringify(identified.body)).toBe(200);
    visitor.adopt(identified.body);
  }
  return fromPublicId('customer', visitor.principalId);
}

const scopeFor = (principalId: string | null): ToolScope => ({
  tenantId,
  brandId: fromPublicId('brand', shop.brand.id),
  conversationId: randomUUID(),
  principalId,
});
const options = () => ({ idempotencyKey: randomUUID(), signal: new AbortController().signal });

describe('connecting a store', () => {
  it('connects Shopify with its token, makes two read tools, and needs the shop’s own address', async () => {
    fake.asked.length = 0;
    fake.seen.length = 0;
    const wrongAddress = await connect({
      kind: 'shopify',
      label: 'Noor shop',
      baseUrl: 'https://shop.noor.example/',
      secret: 'shpat_good',
    });
    expect(wrongAddress.status).toBe(422);
    const whmcsAction = await connect({
      kind: 'shopify',
      label: 'Noor shop',
      baseUrl: 'https://noor-books.myshopify.com/',
      secret: 'shpat_good',
      capabilities: ['refund.handoff'],
    });
    expect(whmcsAction.status).toBe(422);

    const created = await connect({
      kind: 'shopify',
      label: 'Noor shop',
      baseUrl: 'https://noor-books.myshopify.com/',
      secret: 'shpat_good',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'shopify',
      status: 'active',
      lastError: null,
      identityKeyId: null,
      capabilities: expect.arrayContaining(['orders.read', 'order.status']),
    });
    expect(fake.asked).toContain('https://noor-books.myshopify.com/');
    expect(fake.seen.at(-1)?.headers['x-shopify-access-token']).toBe('shpat_good');
    expect(JSON.stringify(created.body)).not.toContain('shpat_good');

    const reads = await toolOf('shopify_orders_read_');
    expect(reads).toMatchObject({
      source: 'native',
      resourceType: 'store',
      risk: 'read',
      status: 'enabled',
      autopilot: true,
      egressHosts: ['noor-books.myshopify.com'],
    });
    expect((await toolOf('shopify_order_status_')).inputSchema).toMatchObject({
      required: ['orderNumber', 'email'],
    });
  });

  it('says a refused WooCommerce key in plain words, and reconnecting fixes it', async () => {
    const created = await connect({
      kind: 'woocommerce',
      label: 'Noor store',
      baseUrl: 'https://shop.noor.example/',
      identifier: 'ck_good',
      secret: 'cs_wrong',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'woocommerce',
      status: 'disabled',
      lastError:
        'WooCommerce refused the key. Check the consumer key and secret, and that the key may read.',
    });
    const withoutKey = await connect({
      kind: 'woocommerce',
      label: 'Second store',
      baseUrl: 'https://second.noor.example/',
      secret: 'cs_good',
    });
    expect(withoutKey.status).toBe(422);
    const id = created.body.id as string;
    const missing = await shop.owner.post(`/v1/admin/connectors/${id}/reconnect`, {
      secret: 'cs_good',
    });
    expect(missing.status).toBe(422);
    const fixed = await shop.owner.post(`/v1/admin/connectors/${id}/reconnect`, {
      identifier: 'ck_good',
      secret: 'cs_good',
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ status: 'active', lastError: null });
    // The WHMCS permission preview is not for stores.
    const preview = await shop.owner.post(`/v1/admin/connectors/${id}/permissions/test`, {
      userId: 1,
      clientId: 1,
    });
    expect(preview.status).toBe(422);
  });
});

describe('orders for the assistant', () => {
  it('finds a signed-in customer’s Shopify orders by their verified email, and only theirs', async () => {
    const stores = slice.gw.app.get(StoreTools);
    const tool = await toolOf('shopify_orders_read_');
    const amina = await customer('Amina@Example.com');
    const result = await stores.execute(tool, {}, scopeFor(amina), options());
    expect(result).toMatchObject({
      status: 'succeeded',
      summary: '1 Shopify order found.',
      output: {
        orders: [
          {
            number: '#1001',
            payment: 'paid',
            fulfilment: 'fulfilled',
            itemCount: 2,
            total: { amount: '59.90', currency: 'EUR' },
            tracking: [{ company: 'DHL', number: 'JD014600', url: null }],
          },
        ],
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/#1002|Secret Street|amina@/i);
    expect(JSON.parse(fake.seen.at(-1)?.body ?? '{}').variables).toEqual({
      query: 'email:"amina@example.com"',
      first: 10,
    });

    // Someone the website did not sign in is asked for the order number and email instead.
    const visitor = await customer();
    await withTenant(slice.app, { tenantId }, async (tx) => {
      expect(await stores.prepare(tx, tool, {}, scopeFor(visitor))).toEqual({
        ok: false,
        summary: expect.stringMatching(/Ask for the order number and the email/),
      });
    });
    await expect(stores.execute(tool, {}, scopeFor(visitor), options())).rejects.toMatchObject({
      kind: 'store_not_signed_in',
    });
  });

  it('looks up one WooCommerce order by number and email; a wrong email finds nothing', async () => {
    const stores = slice.gw.app.get(StoreTools);
    const tool = await toolOf('woocommerce_order_status_');
    const anyone = scopeFor(null);
    const found = await stores.execute(
      tool,
      { orderNumber: '#1048', email: 'SARA@example.com' },
      anyone,
      options(),
    );
    expect(found).toMatchObject({
      status: 'succeeded',
      output: {
        found: true,
        order: {
          number: '1048',
          payment: 'paid',
          fulfilment: 'unfulfilled',
          itemCount: 3,
          total: { amount: '24.00', currency: 'GBP' },
        },
      },
    });
    expect(JSON.stringify(found)).not.toMatch(/Hidden Road|7700|sara@/i);
    const wrongEmail = await stores.execute(
      tool,
      { orderNumber: '1048', email: 'someone@example.com' },
      anyone,
      options(),
    );
    const unknown = await stores.execute(
      tool,
      { orderNumber: '9999', email: 'sara@example.com' },
      anyone,
      options(),
    );
    expect(wrongEmail).toEqual(unknown);
    expect(unknown).toMatchObject({ output: { found: false } });
  });

  it('says a store that is down is down, in the test and to the assistant', async () => {
    const stores = slice.gw.app.get(StoreTools);
    const tool = await toolOf('woocommerce_order_status_');
    fake.down = true;
    try {
      await expect(
        stores.execute(
          tool,
          { orderNumber: '1048', email: 'sara@example.com' },
          scopeFor(null),
          options(),
        ),
      ).rejects.toMatchObject({
        kind: 'store_network',
        message: 'WooCommerce did not answer; try again in a moment.',
        mayHaveApplied: false,
      });
      const items = (await shop.owner.get(`/v1/admin/connectors?brandId=${shop.brand.id}`)).body
        .items as { id: string; kind: string }[];
      const woo = items.find((item) => item.kind === 'woocommerce');
      const test = await shop.owner.post(`/v1/admin/connectors/${woo?.id}/test`, {});
      expect(test.status, JSON.stringify(test.body)).toBe(200);
      expect(test.body).toMatchObject({
        ok: false,
        message: 'WooCommerce did not answer. Check the address and try again.',
      });
    } finally {
      fake.down = false;
    }
  });
});
