import { createHash } from 'node:crypto';
import { callWhmcs, WhmcsApiError } from '@hamnivo/adapters/whmcs';
import { type Db, schema } from '@hamnivo/db';
import { WHMCS_SPEC } from '@hamnivo/domain/connectors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRow, ToolScope } from '../src/actions/adapters.js';
import { WhmcsTools } from '../src/connectors/whmcs-tools.service.js';
import type { EgressService } from '../src/developer/egress.service.js';
import type { SecretBroker } from '../src/secrets/secret-broker.service.js';

vi.mock('@hamnivo/adapters/whmcs', async (original) => ({
  ...(await original<typeof import('@hamnivo/adapters/whmcs')>()),
  callWhmcs: vi.fn(),
}));
vi.mock('@hamnivo/db', async (original) => ({
  ...(await original<typeof import('@hamnivo/db')>()),
  withTenant: (_db: unknown, _scope: unknown, fn: (tx: unknown) => unknown) => fn(_db),
}));
const now = new Date('2026-10-20T12:00:00Z');
const scope: ToolScope = {
  tenantId: 'tenant',
  brandId: 'brand',
  principalId: 'principal',
  conversationId: 'conversation',
};
let data: Map<unknown, unknown[]>;
let tx: any;
let runtime: WhmcsTools;
let tool: ToolRow;
function setup(capability: keyof typeof WHMCS_SPEC = 'invoices.read') {
  const spec = WHMCS_SPEC[capability];
  tool = {
    id: 'tool',
    brandId: 'brand',
    source: 'native',
    remoteName: capability,
    status: 'enabled',
    risk: spec.risk,
    approver: spec.approver,
    autopilot: spec.risk === 'read',
    customerStepUp: spec.approver === 'customer' && spec.risk !== 'read',
    egressHosts: ['billing.example.com'],
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
          kind: 'whmcs',
          status: 'active',
          grantVersion: 1,
          identityKeyId: 'key',
          baseUrl: 'https://billing.example.com/',
          identifierSecretId: 'identifier',
          tokenSecretId: 'secret',
        },
      ],
    ],
    [schema.brandIdentityKeys, [{ status: 'active' }]],
    [
      schema.connectorIdentityBindings,
      [{ userId: 5, clientId: 42, expiresAt: new Date(now.getTime() + 120000) }],
    ],
    [schema.connectorDispatches, []],
    [schema.toolDefinitions, [{ ...tool }]],
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
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (value: unknown) => {
        data.set(table, [...(data.get(table) ?? []), structuredClone(value)]);
        return [];
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  };
  runtime = new WhmcsTools(
    tx as Db,
    () => now,
    { reveal: async () => 'credential' } as unknown as SecretBroker,
    { policyIn: async () => ({}) } as unknown as EgressService,
  );
  vi.mocked(callWhmcs).mockImplementation(async (input) => {
    if (input.action === 'GetUserPermissions')
      return { result: 'success', permissions: { permission: [spec.permission] } };
    if (input.action === 'GetInvoices')
      return {
        result: 'success',
        invoices: {
          invoice: [{ id: 7, userid: 42, total: '10', notes: 'private', password: 'secret' }],
        },
      };
    if (input.action === 'GetTicket')
      return { result: 'success', ticketid: 7, userid: 42, status: 'Open' };
    return { result: 'success', id: 9 };
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  setup();
});
describe('WHMCS native runtime', () => {
  it('checks exact signed user/client permission live and returns only public fields', async () => {
    const result = await runtime.execute(tool, {}, scope, {
      idempotencyKey: 'operation-1',
      signal: new AbortController().signal,
    });
    expect(callWhmcs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'GetUserPermissions',
        fields: { user_id: 5, client_id: 42 },
      }),
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { items: [{ id: 7, total: '10' }] },
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each(['expired', 'revoked', 'disabled', 'grant changed', 'wrong brand', 'policy weakened'])(
    'fails closed for %s',
    async (condition) => {
      if (condition === 'expired')
        data.set(schema.connectorIdentityBindings, [{ userId: 5, clientId: 42, expiresAt: now }]);
      if (condition === 'revoked') data.set(schema.brandIdentityKeys, [{ status: 'revoked' }]);
      if (condition === 'disabled')
        (data.get(schema.connectorConnections)![0] as any).status = 'disabled';
      if (condition === 'grant changed')
        (data.get(schema.connectorToolGrants)![0] as any).version = 2;
      if (condition === 'wrong brand') tool.brandId = 'other';
      if (condition === 'policy weakened') tool.risk = 'write';
      expect(await runtime.prepare(tx, tool, {}, scope)).toMatchObject({ ok: false });
      expect(callWhmcs).not.toHaveBeenCalled();
    },
  );
  it('does not infer permission from success and rejects cross-account API rows', async () => {
    vi.mocked(callWhmcs).mockResolvedValueOnce({ result: 'success' });
    expect(await runtime.prepare(tx, tool, {}, scope)).toMatchObject({ ok: false });
    vi.mocked(callWhmcs)
      .mockResolvedValueOnce({ result: 'success', permissions: ['invoices'] })
      .mockResolvedValueOnce({ result: 'success', invoices: { invoice: [{ id: 9, userid: 43 }] } });
    await expect(
      runtime.execute(tool, {}, scope, {
        idempotencyKey: 'op',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ mayHaveApplied: false });
  });
  it('refuses an owned-resource write when the ticket belongs to another client', async () => {
    setup('tickets.reply');
    vi.mocked(callWhmcs)
      .mockResolvedValueOnce({ result: 'success', permissions: ['tickets'] })
      .mockResolvedValueOnce({ result: 'success', userid: 43 });
    expect(await runtime.prepare(tx, tool, { ticketId: 7, message: 'hello' }, scope)).toMatchObject(
      { ok: false },
    );
    expect(callWhmcs).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AddTicketReply' }),
    );
  });
  it('blocks a matching unresolved dispatch before any new external write', async () => {
    setup('tickets.create');
    data.set(schema.connectorDispatches, [{ state: 'dispatched' }]);
    await expect(
      runtime.execute(tool, { departmentId: 1, subject: 'Help', message: 'Help' }, scope, {
        idempotencyKey: 'new-run',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'whmcs_unknown' });
    expect(callWhmcs).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it('propagates uncertain writes to the existing unknown-outcome workflow', async () => {
    setup('tickets.create');
    vi.mocked(callWhmcs)
      .mockResolvedValueOnce({ result: 'success', permissions: ['tickets'] })
      .mockRejectedValueOnce(new WhmcsApiError('timeout', true));
    await expect(
      runtime.execute(tool, { departmentId: 1, subject: 'Help', message: 'Help' }, scope, {
        idempotencyKey: 'new-run',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ mayHaveApplied: true });
    expect(tx.insert).toHaveBeenCalledWith(schema.connectorDispatches);
    expect(tx.update).not.toHaveBeenCalled();
  });
  it('quotes live without dispatching an upgrade order', async () => {
    setup('upgrade.quote');
    vi.mocked(callWhmcs).mockImplementation(async (input) => {
      if (input.action === 'GetUserPermissions')
        return { result: 'success', permissions: ['manageproducts'] };
      if (input.action === 'GetClientsProducts')
        return {
          result: 'success',
          products: { product: [{ id: 8, clientid: 42, pid: 3, status: 'Active' }] },
        };
      if (input.action === 'UpgradeProduct') return { result: 'success', price: '$12.34 USD' };
      throw new Error('Unexpected API');
    });
    const result = await runtime.execute(
      tool,
      { serviceId: 8, newProductId: 4, billingCycle: 'monthly', paymentMethod: 'paypal' },
      scope,
      { idempotencyKey: 'quote-op', signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { price: '$12.34 USD', requiresStaffApproval: true },
    });
    expect(callWhmcs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'UpgradeProduct',
        fields: expect.objectContaining({ calconly: true }),
      }),
    );
    expect(tx.insert).toHaveBeenCalledWith(schema.connectorQuotes);
    expect(tx.insert).not.toHaveBeenCalledWith(schema.connectorDispatches);
  });
  it('refuses an expired or price-changed saved quote before submitting an upgrade', async () => {
    setup('upgrade.request');
    data.set(schema.connectorQuotes, [
      { price: '$9.00 USD', expiresAt: new Date(now.getTime() + 300000), consumedAt: null },
    ]);
    vi.mocked(callWhmcs)
      .mockResolvedValueOnce({ result: 'success', permissions: ['manageproducts'] })
      .mockResolvedValueOnce({
        result: 'success',
        products: { product: [{ id: 8, clientid: 42, status: 'Active' }] },
      })
      .mockResolvedValueOnce({ result: 'success', price: '$12.34 USD' });
    expect(
      await runtime.prepare(
        tx,
        tool,
        {
          serviceId: 8,
          newProductId: 4,
          billingCycle: 'monthly',
          paymentMethod: 'paypal',
          quoteId: '11111111-1111-1111-1111-111111111111',
        },
        scope,
      ),
    ).toMatchObject({ ok: false });
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it('prepares a refund review packet without calling any refund or mutation API', async () => {
    setup('refund.handoff');
    vi.mocked(callWhmcs)
      .mockResolvedValueOnce({ result: 'success', permissions: ['invoices'] })
      .mockResolvedValueOnce({
        result: 'success',
        userid: 42,
        invoiceid: 7,
        total: '12.34',
        status: 'Paid',
        notes: 'private',
      });
    const result = await runtime.execute(
      tool,
      { invoiceId: 7, reason: 'Duplicate invoice' },
      scope,
      { idempotencyKey: 'refund-op', signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { status: 'manual_review_required', invoiceId: 7 },
    });
    expect(vi.mocked(callWhmcs).mock.calls.map(([input]) => input.action)).toEqual([
      'GetUserPermissions',
      'GetInvoice',
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([
    'connection disabled',
    'connection version',
    'grant removed',
    'key revoked',
    'binding expired',
    'binding switched',
    'tool disabled',
    'tool revised',
  ])('blocks dispatch when %s changes while permission I/O is pending', async (change) => {
    setup('tickets.create');
    let enter!: () => void;
    let release!: (value: Record<string, unknown>) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    vi.mocked(callWhmcs).mockImplementation(async (input) => {
      if (input.action === 'GetUserPermissions') {
        enter();
        return pending;
      }
      throw new Error('Must not dispatch after revocation');
    });
    const execution = runtime.execute(
      tool,
      { departmentId: 1, subject: 'Help', message: 'Help' },
      scope,
      { idempotencyKey: 'race', signal: new AbortController().signal },
    );
    await entered;
    const changeRow = (table: unknown, patch: Record<string, unknown>) =>
      data.set(table, [{ ...(data.get(table)![0] as Record<string, unknown>), ...patch }]);
    if (change === 'connection disabled')
      changeRow(schema.connectorConnections, { status: 'disabled' });
    if (change === 'connection version')
      changeRow(schema.connectorConnections, { grantVersion: 2 });
    if (change === 'grant removed') changeRow(schema.connectorToolGrants, { enabled: 'no' });
    if (change === 'key revoked') changeRow(schema.brandIdentityKeys, { status: 'revoked' });
    if (change === 'binding expired')
      changeRow(schema.connectorIdentityBindings, { expiresAt: now });
    if (change === 'binding switched')
      changeRow(schema.connectorIdentityBindings, { clientId: 99 });
    if (change === 'tool disabled') changeRow(schema.toolDefinitions, { status: 'disabled' });
    if (change === 'tool revised') changeRow(schema.toolDefinitions, { revision: 2 });
    release({ result: 'success', permissions: ['tickets'] });
    await expect(execution).rejects.toMatchObject({ kind: 'whmcs_denied', mayHaveApplied: false });
    expect(callWhmcs).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
  it('does not consume a valid quote when the identity key is revoked during its live recalculation', async () => {
    setup('upgrade.request');
    const resource = { id: 8, clientid: 42, pid: 3, status: 'Active' };
    const quoteId = '11111111-1111-1111-1111-111111111111';
    const args = {
      serviceId: 8,
      newProductId: 4,
      billingCycle: 'monthly',
      paymentMethod: 'paypal',
      quoteId,
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          args: {
            serviceid: 8,
            newproductid: 4,
            newproductbillingcycle: 'monthly',
            paymentmethod: 'paypal',
            type: 'product',
          },
          resource,
          grant: 1,
        }),
      )
      .digest('hex');
    data.set(schema.connectorQuotes, [
      {
        id: quoteId,
        price: '$12.34 USD',
        fingerprint,
        consumedAt: null,
        expiresAt: new Date(now.getTime() + 300000),
      },
    ]);
    let enter!: () => void;
    let release!: (value: Record<string, unknown>) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    vi.mocked(callWhmcs).mockImplementation(async (input) => {
      if (input.action === 'GetUserPermissions')
        return { result: 'success', permissions: ['manageproducts'] };
      if (input.action === 'GetClientsProducts')
        return { result: 'success', products: { product: [resource] } };
      if (input.action === 'UpgradeProduct' && input.fields?.calconly === true) {
        enter();
        return pending;
      }
      throw new Error('Upgrade must not be submitted');
    });
    const execution = runtime.execute(tool, args, scope, {
      idempotencyKey: 'quote-race',
      signal: new AbortController().signal,
    });
    await entered;
    data.set(schema.brandIdentityKeys, [{ status: 'revoked' }]);
    release({ result: 'success', price: '$12.34 USD' });
    await expect(execution).rejects.toMatchObject({ kind: 'whmcs_denied', mayHaveApplied: false });
    expect(callWhmcs).toHaveBeenCalledTimes(3);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
  it('retains the dispatch fence after an ambiguous JSON response and blocks another run', async () => {
    setup('tickets.create');
    vi.mocked(callWhmcs).mockImplementation(async (input) => {
      if (input.action === 'GetUserPermissions')
        return { result: 'success', permissions: ['tickets'] };
      throw new WhmcsApiError('response', true);
    });
    const args = { departmentId: 1, subject: 'Help', message: 'Help' };
    await expect(
      runtime.execute(tool, args, scope, {
        idempotencyKey: 'first-run',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'whmcs_response', mayHaveApplied: true });
    expect(data.get(schema.connectorDispatches)).toEqual([
      expect.objectContaining({ state: 'dispatched' }),
    ]);
    await expect(
      runtime.execute(tool, args, scope, {
        idempotencyKey: 'second-run',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'whmcs_unknown', mayHaveApplied: false });
    expect(
      vi.mocked(callWhmcs).mock.calls.filter(([input]) => input.action === 'OpenTicket'),
    ).toHaveLength(1);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
