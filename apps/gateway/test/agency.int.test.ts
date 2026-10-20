import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Gateway, signUp, startGateway } from './harness.js';

let gw: Gateway;
let owner: Client;
let agencyTenant: string;
let clientTenant: string;

beforeAll(async () => {
  gw = await startGateway({ HAMNIVO_PUBLIC_SIGNUP: 'false' });
  owner = await signUp(gw, 'Agency Owner', 'agency-owner@example.com');
  const created = await owner.post('/v1/tenants', { name: 'Agency', slug: 'agency' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  agencyTenant = created.body.tenant.id;
  owner.tenant = agencyTenant;
});

afterAll(async () => {
  await gw?.close();
});

describe('agency client directory', () => {
  it('creates a separate tenant atomically despite closed public signup and replays by key', async () => {
    const initial = await owner.get('/v1/admin/agency');
    expect(initial.status).toBe(200);
    expect(initial.body.enabled).toBe(false);

    const enabled = await owner.patch('/v1/admin/agency', {
      enabled: true,
      branding: { displayName: 'Agency Desk' },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body).toMatchObject({
      enabled: true,
      branding: { displayName: 'Agency Desk', accentColor: null },
    });

    const key = { 'idempotency-key': 'agency-client-one' };
    const first = await owner.post(
      '/v1/admin/agency/clients',
      { name: 'Client One', slug: 'client-one' },
      { headers: key },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      tenant: { name: 'Client One', slug: 'client-one' },
      canAccess: true,
    });
    clientTenant = first.body.tenant.id;

    const replay = await owner.post(
      '/v1/admin/agency/clients',
      { name: 'Client One', slug: 'client-one' },
      { headers: key },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.tenant.id).toBe(clientTenant);

    const listed = await owner.get('/v1/admin/agency/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].tenant.id).toBe(clientTenant);
    const childMe = await owner.get('/v1/me', { tenant: clientTenant });
    expect(childMe.body.current.tenantId).toBe(clientTenant);
  });

  it('does not turn an agency viewer into a member of the child', async () => {
    const role = await owner.post('/v1/admin/roles', {
      key: 'agency_viewer',
      name: 'Agency viewer',
      permissions: ['agency.read'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const invite = await owner.post('/v1/admin/invitations', {
      email: 'agency-viewer@example.com',
      roleId: role.body.id,
      scope: { type: 'tenant' },
    });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const viewer = await signUp(gw, 'Agency Viewer', 'agency-viewer@example.com');
    expect((await viewer.post('/v1/invitations/accept', { token: invite.body.token })).status).toBe(
      200,
    );
    viewer.tenant = agencyTenant;
    const listed = await viewer.get('/v1/admin/agency/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].canAccess).toBe(false);
    expect((await viewer.get('/v1/admin/agency', { tenant: clientTenant })).status).toBe(404);
  });

  it('rejects nesting, then unlinks without removing the client tenant or its owner', async () => {
    expect(
      (await owner.patch('/v1/admin/agency', { enabled: true }, { tenant: clientTenant })).status,
    ).toBe(422);
    expect(
      (await owner.post('/v1/admin/agency/clients/link', { tenantId: agencyTenant })).status,
    ).toBe(422);
    expect((await owner.delete(`/v1/admin/agency/clients/${clientTenant}`)).status).toBe(204);
    expect((await owner.get('/v1/admin/agency/clients')).body.items).toHaveLength(0);
    expect((await owner.get('/v1/me', { tenant: clientTenant })).body.current.tenantId).toBe(
      clientTenant,
    );

    const role = await owner.post('/v1/admin/roles', {
      key: 'agency_manager',
      name: 'Agency manager',
      permissions: ['agency.read', 'agency.manage'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const invitation = await owner.post('/v1/admin/invitations', {
      email: 'agency-manager@example.com',
      roleId: role.body.id,
      scope: { type: 'tenant' },
    });
    expect(invitation.status).toBe(201);
    const manager = await signUp(gw, 'Agency Manager', 'agency-manager@example.com');
    expect(
      (await manager.post('/v1/invitations/accept', { token: invitation.body.token })).status,
    ).toBe(200);
    manager.tenant = agencyTenant;
    expect(
      (await manager.post('/v1/admin/agency/clients/link', { tenantId: clientTenant })).status,
    ).toBe(404);

    const linked = await owner.post('/v1/admin/agency/clients/link', { tenantId: clientTenant });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.tenant.id).toBe(clientTenant);
  });
});
