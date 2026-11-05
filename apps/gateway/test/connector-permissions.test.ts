import { callWhmcs } from '@hamnivo/adapters/whmcs';
import { appendAudit, type Db, newId, schema, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
import type { EgressService } from '../src/developer/egress.service.js';
import type { SecretBroker } from '../src/secrets/secret-broker.service.js';

vi.mock('@hamnivo/adapters/whmcs', async (original) => ({
  ...(await original<typeof import('@hamnivo/adapters/whmcs')>()),
  callWhmcs: vi.fn(),
}));
vi.mock('@hamnivo/db', async (original) => ({
  ...(await original<typeof import('@hamnivo/db')>()),
  withTenant: (_db: unknown, _scope: unknown, fn: (tx: unknown) => unknown) => fn(_db),
  appendAudit: vi.fn(async () => {}),
}));
const now = new Date('2026-10-20T12:00:00Z');
let data: Map<unknown, unknown[]>;
let principal: StaffPrincipal;
let connectionId: string;
let service: ConnectorsService;
let reveal: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  const id = newId();
  const brandId = newId();
  const tenantId = newId();
  connectionId = toPublicId('connection', id);
  principal = {
    kind: 'staff',
    tenantId,
    staffMemberId: newId(),
    status: 'active',
    mfa: true,
    authenticatedAt: now,
    grants: [
      {
        id: newId(),
        permissions: ['tools.manage'],
        scope: { type: 'brand', id: brandId },
        revokedAt: null,
        expiresAt: null,
      },
    ],
  };
  data = new Map<unknown, unknown[]>([
    [
      schema.connectorConnections,
      [
        {
          id,
          tenantId,
          brandId,
          workspaceId: newId(),
          status: 'active',
          grantVersion: 1,
          baseUrl: 'https://billing.example.com/',
          identifierSecretId: newId(),
          tokenSecretId: newId(),
        },
      ],
    ],
    [
      schema.connectorToolGrants,
      [
        { capability: 'invoices.read', enabled: 'yes', version: 1 },
        { capability: 'tickets.reply', enabled: 'no', version: 1 },
      ],
    ],
  ]);
  const tx = {
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
  reveal = vi.fn(async () => 'stored-secret');
  service = new ConnectorsService(
    tx as unknown as Db,
    () => now,
    { reveal } as unknown as SecretBroker,
    { policyIn: async () => ({}) } as unknown as EgressService,
    { STEP_UP_MAX_AGE_MINUTES: 10 } as AppConfig,
  );
  vi.mocked(callWhmcs).mockResolvedValue({
    result: 'success',
    permissions: { permission: ['invoices', 'tickets'] },
    notes: 'private staff note',
    secret: 'remote-secret',
  });
});

describe('live WHMCS user/client permission preview', () => {
  it('checks the actual pair and intersects explicit permissions with configured grants', async () => {
    const result = await service.testPermissions(principal, connectionId, {
      userId: 5,
      clientId: 42,
    });
    expect(callWhmcs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'GetUserPermissions',
        fields: { user_id: 5, client_id: 42 },
      }),
    );
    expect(result).toMatchObject({ ok: true, userId: 5, clientId: 42 });
    expect(result.items.find((item) => item.capability === 'invoices.read')).toMatchObject({
      configured: true,
      requiredPermission: 'invoices',
      allowed: true,
      reason: 'allowed',
    });
    expect(result.items.find((item) => item.capability === 'tickets.reply')).toMatchObject({
      configured: false,
      requiredPermission: 'tickets',
      allowed: false,
      reason: 'grant_disabled',
    });
    expect(result.items.find((item) => item.capability === 'services.read')).toMatchObject({
      configured: false,
      allowed: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/stored-secret|remote-secret|private staff note/);
    expect(appendAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'connector.permissions_tested',
        data: expect.objectContaining({ userId: 5, clientId: 42, verified: true }),
      }),
    );
  });
  it('denies a connector in another brand before revealing credentials or calling WHMCS', async () => {
    principal = {
      ...principal,
      grants: [{ ...principal.grants[0]!, scope: { type: 'brand', id: newId() } }],
    };
    await expect(
      service.testPermissions(principal, connectionId, { userId: 5, clientId: 42 }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(reveal).not.toHaveBeenCalled();
    expect(callWhmcs).not.toHaveBeenCalled();
  });
  it('requires fresh staff authentication', async () => {
    principal = { ...principal, authenticatedAt: new Date(now.getTime() - 11 * 60000) };
    await expect(
      service.testPermissions(principal, connectionId, { userId: 5, clientId: 42 }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(reveal).not.toHaveBeenCalled();
    expect(callWhmcs).not.toHaveBeenCalled();
  });
  it.each([
    { result: 'success' },
    { result: 'success', permissions: 'invoices' },
    { result: 'success', permissions: ['invoices', {}] },
  ])('fails closed for incomplete or malformed permissions %j', async (response) => {
    vi.mocked(callWhmcs).mockResolvedValue(response);
    const result = await service.testPermissions(principal, connectionId, {
      userId: 5,
      clientId: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.items.every((item) => !item.allowed)).toBe(true);
    expect(result.items.find((item) => item.capability === 'invoices.read')?.reason).toBe(
      'permission_unverified',
    );
  });
  it('distinguishes an explicit denial from an unverified response', async () => {
    vi.mocked(callWhmcs).mockResolvedValue({ result: 'success', permissions: [] });
    const result = await service.testPermissions(principal, connectionId, {
      userId: 5,
      clientId: 42,
    });
    expect(result.ok).toBe(true);
    expect(result.items.find((item) => item.capability === 'invoices.read')?.reason).toBe(
      'permission_denied',
    );
  });
  it('reports grants revoked while the live lookup was pending', async () => {
    vi.mocked(callWhmcs).mockImplementation(async () => {
      data.set(schema.connectorToolGrants, []);
      return { result: 'success', permissions: ['invoices'] };
    });
    const result = await service.testPermissions(principal, connectionId, {
      userId: 5,
      clientId: 42,
    });
    expect(result.items.every((item) => !item.allowed)).toBe(true);
  });
});
