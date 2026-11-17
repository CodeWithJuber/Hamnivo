import { callShopify, callWooCommerce, StoreApiError } from '@hamnivo/adapters/stores';
import { type Db, schema } from '@hamnivo/db';
import { STORE_SPEC, type StoreCapability } from '@hamnivo/domain/connectors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRow, ToolScope } from '../src/actions/adapters.js';
import { StoreTools } from '../src/connectors/store-tools.service.js';
import type { EgressService } from '../src/developer/egress.service.js';
import type { SecretBroker } from '../src/secrets/secret-broker.service.js';

vi.mock('@hamnivo/adapters/stores', async (original) => ({
  ...(await original<typeof import('@hamnivo/adapters/stores')>()),
  callShopify: vi.fn(),
  callWooCommerce: vi.fn(),
}));
vi.mock('@hamnivo/db', async (original) => ({
  ...(await original<typeof import('@hamnivo/db')>()),
  withTenant: (_db: unknown, _scope: unknown, fn: (tx: unknown) => unknown) => fn(_db),
}));

const scope: ToolScope = {
  tenantId: 'tenant',
  brandId: 'brand',
  principalId: 'principal',
  conversationId: 'conversation',
};
const options = () => ({ idempotencyKey: 'op', signal: new AbortController().signal });
let data: Map<unknown, unknown[]>;
let runtime: StoreTools;
let tool: ToolRow;
let tx: unknown;

function setup(kind: 'shopify' | 'woocommerce', capability: StoreCapability) {
  tool = {
    id: 'tool',
    brandId: 'brand',
    source: 'native',
    remoteName: capability,
    status: 'enabled',
    risk: STORE_SPEC[capability].risk,
    approver: 'customer',
    autopilot: true,
    customerStepUp: false,
    egressHosts: ['noor-books.myshopify.com', 'shop.noor.example'],
    timeoutMs: 5000,
    revision: 1,
  } as ToolRow;
  data = new Map<unknown, unknown[]>([
    [
      schema.connectorToolGrants,
      [{ connectionId: 'connection', capability, version: 1, enabled: 'yes' }],
    ],
    [
      schema.connectorConnections,
      [
        {
          id: 'connection',
          brandId: 'brand',
          kind,
          status: 'active',
          grantVersion: 1,
          baseUrl:
            kind === 'shopify' ? 'https://noor-books.myshopify.com/' : 'https://shop.noor.example/',
          identifierSecretId: kind === 'shopify' ? null : 'identifier',
          tokenSecretId: 'secret',
        },
      ],
    ],
    [
      schema.customerPrincipals,
      [
        {
          id: 'principal',
          brandId: 'brand',
          kind: 'verified',
          email: 'Amina@Example.com',
          emailVerifiedAt: new Date('2026-11-17T09:00:00Z'),
        },
      ],
    ],
  ]);
  tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = Object.assign(Promise.resolve(structuredClone(data.get(table) ?? [])), {
          where: () => query,
          for: () => query,
        });
        return query;
      },
    }),
  };
  runtime = new StoreTools(
    tx as unknown as Db,
    {
      reveal: async (_tx: unknown, _t: string, id: string) => `${id}-value`,
    } as unknown as SecretBroker,
    { policyIn: async () => ({}) } as unknown as EgressService,
  );
}

const shopifyOrder = (name: string, email: string) => ({
  name,
  email,
  createdAt: '2026-11-10T09:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currentSubtotalLineItemsQuantity: 2,
  currentTotalPriceSet: { shopMoney: { amount: '30.00', currencyCode: 'EUR' } },
  fulfillments: [{ trackingInfo: [{ company: 'DHL', number: 'JD1', url: null }] }],
  shippingAddress: { address1: '1 Secret Street' },
});
const wooOrder = (id: number, email: string, number = String(id)) => ({
  id,
  number,
  status: 'processing',
  date_created_gmt: '2026-11-11T08:30:00',
  currency: 'GBP',
  total: '24.00',
  billing: { email, address_1: '2 Hidden Road' },
  line_items: [{ quantity: 1 }],
  meta_data: [],
});

beforeEach(() => vi.clearAllMocks());

describe('store orders for the assistant', () => {
  it('finds a signed-in customer’s Shopify orders by their verified email only', async () => {
    setup('shopify', 'orders.read');
    vi.mocked(callShopify).mockResolvedValue({
      orders: {
        nodes: [
          shopifyOrder('#1001', 'amina@example.com'),
          // A loose match by the store's search, placed by someone else: never shown.
          shopifyOrder('#1002', 'amina@example.com.attacker.example'),
        ],
      },
    });
    const prepared = await runtime.prepare(tx as never, tool, {}, scope);
    expect(prepared.ok).toBe(true);
    const result = await runtime.execute(tool, {}, scope, options());
    expect(callShopify).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://noor-books.myshopify.com/',
        token: 'secret-value',
        query: 'orders',
        search: 'email:"amina@example.com"',
        first: 10,
      }),
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      output: {
        orders: [
          {
            number: '#1001',
            payment: 'paid',
            fulfilment: 'fulfilled',
            itemCount: 2,
            total: { amount: '30.00', currency: 'EUR' },
            tracking: [{ company: 'DHL', number: 'JD1', url: null }],
          },
        ],
      },
      summary: '1 Shopify order found.',
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Secret Street|amina@|#1002/);
  });

  it('asks for the order number and email when the customer is not signed in', async () => {
    setup('shopify', 'orders.read');
    data.set(schema.customerPrincipals, [{ id: 'principal', brandId: 'brand', kind: 'anonymous' }]);
    const prepared = await runtime.prepare(tx as never, tool, {}, scope);
    expect(prepared).toEqual({
      ok: false,
      summary: expect.stringMatching(/Ask for the order number and the email/),
    });
    await expect(runtime.execute(tool, {}, scope, options())).rejects.toMatchObject({
      kind: 'store_not_signed_in',
      mayHaveApplied: false,
    });
    expect(callShopify).not.toHaveBeenCalled();
  });

  it('looks up one WooCommerce order by number and email; a wrong email reads as no order', async () => {
    setup('woocommerce', 'order.status');
    vi.mocked(callWooCommerce).mockImplementation(async (input) =>
      input.read.kind === 'order' && input.read.id === 1048
        ? wooOrder(1048, 'sara@example.com')
        : input.read.kind === 'order'
          ? null
          : [],
    );
    const right = await runtime.execute(
      tool,
      { orderNumber: '#1048', email: 'SARA@example.com' },
      scope,
      options(),
    );
    expect(right).toMatchObject({
      status: 'succeeded',
      output: {
        found: true,
        order: { number: '1048', payment: 'paid', fulfilment: 'unfulfilled' },
      },
    });
    expect(JSON.stringify(right)).not.toMatch(/Hidden Road|sara@/);
    expect(callWooCommerce).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'identifier-value', secret: 'secret-value' }),
    );
    const wrongEmail = await runtime.execute(
      tool,
      { orderNumber: '1048', email: 'someone@example.com' },
      scope,
      options(),
    );
    const unknown = await runtime.execute(
      tool,
      { orderNumber: '9999', email: 'sara@example.com' },
      scope,
      options(),
    );
    expect(wrongEmail).toEqual(unknown);
    expect(wrongEmail).toMatchObject({ output: { found: false } });
    // Without both, nothing is asked of the store.
    vi.mocked(callWooCommerce).mockClear();
    expect((await runtime.prepare(tx as never, tool, { orderNumber: '1048' }, scope)).ok).toBe(
      false,
    );
    await expect(
      runtime.execute(tool, { orderNumber: '10 48', email: 'sara@example.com' }, scope, options()),
    ).rejects.toMatchObject({ kind: 'store_invalid' });
    expect(callWooCommerce).not.toHaveBeenCalled();
  });

  it('finds an order numbered the store’s own way by searching for it', async () => {
    setup('woocommerce', 'order.status');
    vi.mocked(callWooCommerce).mockResolvedValue([
      wooOrder(77, 'sara@example.com', 'NL-1047'),
      wooOrder(78, 'sara@example.com', 'NL-1048'),
    ]);
    const result = await runtime.execute(
      tool,
      { orderNumber: 'nl-1048', email: 'sara@example.com' },
      scope,
      options(),
    );
    expect(result).toMatchObject({ output: { found: true, order: { number: 'NL-1048' } } });
    expect(callWooCommerce).toHaveBeenCalledWith(
      expect.objectContaining({ read: { kind: 'orders', search: 'nl-1048', perPage: 5 } }),
    );
  });

  it('says a store that is down is down, and that nothing changed', async () => {
    setup('woocommerce', 'order.status');
    vi.mocked(callWooCommerce).mockRejectedValue(new StoreApiError('network'));
    await expect(
      runtime.execute(tool, { orderNumber: '1048', email: 'sara@example.com' }, scope, options()),
    ).rejects.toMatchObject({
      kind: 'store_network',
      message: 'WooCommerce did not answer; try again in a moment.',
      mayHaveApplied: false,
    });
    vi.mocked(callWooCommerce).mockRejectedValue(new StoreApiError('auth'));
    await expect(
      runtime.execute(tool, { orderNumber: '1048', email: 'sara@example.com' }, scope, options()),
    ).rejects.toMatchObject({ kind: 'store_auth', message: /check the connection in Studio/ });
  });

  it.each(['disabled', 'grant changed', 'other brand', 'host not allowed', 'write tool'])(
    'refuses when the %s',
    async (condition) => {
      setup('shopify', 'orders.read');
      const connection = data.get(schema.connectorConnections)?.[0] as Record<string, unknown>;
      if (condition === 'disabled') connection.status = 'disabled';
      if (condition === 'grant changed') connection.grantVersion = 2;
      if (condition === 'other brand') tool = { ...tool, brandId: 'other' };
      if (condition === 'host not allowed') tool = { ...tool, egressHosts: ['elsewhere.example'] };
      if (condition === 'write tool') tool = { ...tool, risk: 'write' };
      await expect(runtime.execute(tool, {}, scope, options())).rejects.toMatchObject({
        kind: 'store_unavailable',
      });
      expect(callShopify).not.toHaveBeenCalled();
    },
  );
});
