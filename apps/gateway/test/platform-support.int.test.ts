import {
  fromPublicId,
  schema,
  setPlatformOperator,
  verifyPlatformAuditChain,
  withTenant,
} from '@hamnivo/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ageSessions,
  enrolTotp,
  join,
  roleIds,
  signInWithTotp,
  tenantWithOwner,
} from './access-support.js';
import { Client, type Gateway, signUp, startGateway } from './harness.js';

let gw: Gateway;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let pat: Client;
let ada: Client;
let vic: Client;
let ownerTotp = '';

const REASON = 'Customer reports that the widget stopped answering since this morning.';

async function operator(
  name: string,
  email: string,
  role: 'platform_admin' | 'support_operator' | 'platform_viewer',
  mfa: boolean,
) {
  const person = await signUp(gw, name, email);
  await setPlatformOperator(gw.owner, { email, role });
  return mfa ? (await enrolTotp(gw, person, email)).client : person;
}

async function requestAccess(client: Client, tenantId: string, body: Record<string, unknown> = {}) {
  const reply = await client.post('/v1/platform/support-grants', {
    tenantId,
    reason: REASON,
    ...body,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as { id: string; state: string; scopes: string[] };
}

async function tenantAudit(client: Client, action: string) {
  const reply = await client.get(`/v1/admin/audit?action=${action}&limit=50`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.items as Array<{
    actor: { type: string; id: string };
    data: Record<string, unknown>;
    target: { id: string } | null;
  }>;
}

beforeAll(async () => {
  gw = await startGateway();
  const signedUp = await tenantWithOwner(gw, 'Nora Owner', 'nora@example.com', 'northwind');
  const enrolled = await enrolTotp(gw, signedUp, 'nora@example.com');
  owner = enrolled.client;
  ownerTotp = enrolled.uri;
  const roles = await roleIds(owner);
  agent = (await join(gw, owner, 'Aziz Agent', 'aziz@example.com', roles.agent as string)).client;
  otherOwner = (
    await enrolTotp(
      gw,
      await tenantWithOwner(gw, 'Otto Owner', 'otto@example.com', 'otherco'),
      'otto@example.com',
    )
  ).client;
  pat = await operator('Pat Operator', 'pat@hamnivo.example', 'support_operator', true);
  ada = await operator('Ada Admin', 'ada@hamnivo.example', 'platform_admin', true);
  vic = await operator('Vic Viewer', 'vic@hamnivo.example', 'platform_viewer', false);
});

afterAll(async () => {
  await gw?.close();
});

describe('the platform console (A17)', () => {
  it('is only for platform operators, with platform permissions separate from tenant roles', async () => {
    expect((await new Client(gw.app).get('/v1/platform/me')).status).toBe(401);
    // A tenant owner holds every tenant permission and still has no console.
    expect((await owner.get('/v1/platform/me')).status).toBe(404);
    expect((await owner.get('/v1/platform/tenants')).status).toBe(404);

    const me = await vic.get('/v1/platform/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      name: 'Vic Viewer',
      role: 'platform_viewer',
      permissions: ['platform.tenants.read', 'platform.health.read'],
      mfa: false,
    });
    expect((await vic.get('/v1/platform/tenants')).status).toBe(200);
    expect((await vic.get('/v1/platform/support-grants')).status).toBe(403);
    expect((await vic.get('/v1/platform/audit')).status).toBe(403);

    // …and being an operator opens no tenant: only an approved support grant does.
    const members = await pat.get('/v1/admin/members', { tenant: owner.tenant });
    expect(members.status).toBe(404);

    await setPlatformOperator(gw.owner, { email: 'vic@hamnivo.example', disable: true });
    expect((await vic.get('/v1/platform/me')).status).toBe(404);
  });

  it('shows tenants, health and AI stops as metadata, never tenant content', async () => {
    const stop = await owner.post('/v1/admin/kill-switches', {
      scope: 'tenant',
      reason: 'Pausing the AI while prices change',
    });
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);

    const list = await pat.get('/v1/platform/tenants?query=north');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const [tenant] = list.body.items;
    expect(Object.keys(tenant).sort()).toEqual(
      [
        'activeSupportGrants',
        'aiStops',
        'brands',
        'connectors',
        'createdAt',
        'id',
        'name',
        'providersOff',
        'region',
        'slug',
        'status',
        'workspaces',
      ].sort(),
    );
    expect(tenant).toMatchObject({
      id: owner.tenant,
      slug: 'northwind',
      status: 'active',
      workspaces: 1,
      aiStops: 1,
      activeSupportGrants: 0,
    });
    const detail = await pat.get(`/v1/platform/tenants/${owner.tenant}`);
    expect(detail.status).toBe(200);
    expect(detail.body.aiStopList).toEqual([
      expect.objectContaining({ scope: 'tenant', since: expect.any(String) }),
    ]);
    const text = JSON.stringify(detail.body);
    for (const content of ['nora@example.com', 'aziz@example.com', 'Aziz', 'Pausing the AI']) {
      expect(text).not.toContain(content);
    }
    expect((await pat.get('/v1/platform/tenants/tnt_nonsense')).status).toBe(404);

    const overview = await pat.get('/v1/platform/overview');
    expect(overview.body).toMatchObject({
      tenants: { total: 2, active: 2, suspended: 0 },
      aiStops: 1,
      incidents: [],
    });
    const health = await pat.get('/v1/platform/health');
    expect(health.status).toBe(200);
    expect(health.body.services).toEqual(
      expect.arrayContaining([
        { key: 'database', state: 'healthy' },
        { key: 'valkey', state: 'healthy' },
      ]),
    );
  });
});

describe('support access (A18)', () => {
  let grantId: string;

  it('asks the workspace, which sees the request and nothing is shared yet', async () => {
    const grant = await requestAccess(pat, owner.tenant as string, {
      scopes: ['configuration', 'conversations', 'audit'],
      durationMinutes: 60,
    });
    expect(grant).toMatchObject({
      state: 'pending',
      scopes: ['configuration', 'conversations', 'audit'],
    });
    grantId = grant.id;
    const notices = await agent.get('/v1/workspace/notices');
    expect(notices.status).toBe(200);
    expect(notices.body).toMatchObject({ supportAccess: [], pendingSupportRequests: 1 });
    expect(gw.mailer.last('nora@example.com', 'support.requested')?.text).toContain(REASON);
    expect(gw.mailer.last('aziz@example.com', 'support.requested')).toBeUndefined();
    const [requested] = await tenantAudit(owner, 'support.requested');
    expect(requested?.actor.type).toBe('platform');
    expect(requested?.data).toMatchObject({ operatorName: 'Pat Operator' });

    const early = await pat.get(`/v1/platform/support-grants/${grantId}/configuration`);
    expect(early.status).toBe(403);
    expect(early.body.detail).toContain('not approved');
    expect((await agent.post(`/v1/admin/support-grants/${grantId}/approve`, {})).status).toBe(403);
    await ageSessions(gw, 'nora@example.com');
    const stale = await owner.post(`/v1/admin/support-grants/${grantId}/approve`, {});
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
  });

  it('lets an owner approve it narrower and shorter, never wider or longer', async () => {
    const fresh = await freshOwner();
    const longer = await fresh.post(`/v1/admin/support-grants/${grantId}/approve`, {
      durationMinutes: 120,
    });
    expect(longer.status).toBe(422);
    const approved = await fresh.post(`/v1/admin/support-grants/${grantId}/approve`, {
      scopes: ['configuration'],
      durationMinutes: 30,
      note: 'Only the setup, please',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      state: 'active',
      scopes: ['configuration'],
      durationMinutes: 30,
      decidedBy: { displayName: 'Nora Owner' },
      decisionNote: 'Only the setup, please',
    });
    const expires = new Date(approved.body.expiresAt).getTime();
    expect(expires - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect((await fresh.post(`/v1/admin/support-grants/${grantId}/approve`, {})).body.code).toBe(
      'VERSION_CONFLICT',
    );

    const notices = await agent.get('/v1/workspace/notices');
    expect(notices.body).toMatchObject({
      supportAccess: [{ id: grantId, operatorName: 'Pat Operator', scopes: ['configuration'] }],
      pendingSupportRequests: 0,
    });
  });

  it('reads only the approved area, read-only, recorded on both sides', async () => {
    const configuration = await pat.get(`/v1/platform/support-grants/${grantId}/configuration`);
    expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
    expect(configuration.body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'aziz@example.com',
      'nora@example.com',
    ]);
    for (const area of ['conversations', 'audit']) {
      const denied = await pat.get(`/v1/platform/support-grants/${grantId}/${area}`);
      expect(denied.status, area).toBe(403);
      expect(denied.body.detail).toContain('did not approve');
    }
    // Another operator cannot use Pat's grant.
    expect((await ada.get(`/v1/platform/support-grants/${grantId}/configuration`)).status).toBe(
      404,
    );
    const [accessed] = await tenantAudit(owner, 'support.accessed');
    expect(accessed).toMatchObject({
      actor: { type: 'platform' },
      data: { area: 'configuration', operatorName: 'Pat Operator' },
    });
    const platformLog = await ada.get('/v1/platform/audit?limit=100');
    expect(platformLog.status).toBe(200);
    const actions = platformLog.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['support.requested', 'support.approved', 'support.accessed']),
    );
    expect(
      platformLog.body.items.find((e: { action: string }) => e.action === 'support.approved'),
    ).toMatchObject({ operator: null, tenant: { id: owner.tenant, name: expect.any(String) } });
    const tenants = await pat.get('/v1/platform/tenants?query=northwind');
    expect(tenants.body.items[0].activeSupportGrants).toBe(1);
  });

  it('ends at the approved time', async () => {
    await withTenant(gw.owner, { tenantId: fromPublicId('tenant', owner.tenant as string) }, (tx) =>
      tx
        .update(schema.supportGrants)
        .set({
          startsAt: sql`now() - interval '31 minutes'`,
          expiresAt: sql`now() - interval '1 minute'`,
        })
        .where(eq(schema.supportGrants.id, fromPublicId('supportGrant', grantId))),
    );
    const after = await pat.get(`/v1/platform/support-grants/${grantId}/configuration`);
    expect(after.status).toBe(403);
    expect(after.body.detail).toContain('has ended');
    expect((await agent.get('/v1/workspace/notices')).body.supportAccess).toEqual([]);
    const fresh = await freshOwner();
    const listed = (await fresh.get('/v1/admin/support-grants')).body.items;
    expect(listed.find((g: { id: string }) => g.id === grantId)?.state).toBe('expired');
    // Revoking what already ended changes nothing.
    const revoke = await fresh.post(`/v1/admin/support-grants/${grantId}/revoke`, {});
    expect(revoke.body.state).toBe('expired');
  });

  it('can be revoked by the workspace or ended by the operator at any time', async () => {
    const fresh = await freshOwner();
    const second = await requestAccess(pat, owner.tenant as string, { scopes: ['audit'] });
    expect((await fresh.post(`/v1/admin/support-grants/${second.id}/approve`, {})).status).toBe(
      200,
    );
    const read = await pat.get(`/v1/platform/support-grants/${second.id}/audit`);
    expect(read.status).toBe(200);
    expect(read.body.items.length).toBeGreaterThan(0);
    const revoked = await fresh.post(`/v1/admin/support-grants/${second.id}/revoke`, {
      note: 'Resolved on our side',
    });
    expect(revoked.body.state).toBe('revoked');
    expect((await pat.get(`/v1/platform/support-grants/${second.id}/audit`)).status).toBe(403);

    const third = await requestAccess(pat, owner.tenant as string);
    await fresh.post(`/v1/admin/support-grants/${third.id}/approve`, {});
    const ended = await pat.post(`/v1/platform/support-grants/${third.id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.state).toBe('ended');
    expect((await pat.get(`/v1/platform/support-grants/${third.id}/configuration`)).status).toBe(
      403,
    );
    expect((await tenantAudit(fresh, 'support.ended'))[0]?.actor.type).toBe('platform');

    const fourth = await requestAccess(pat, owner.tenant as string);
    const declined = await fresh.post(`/v1/admin/support-grants/${fourth.id}/decline`, {
      note: 'Not now',
    });
    expect(declined.body).toMatchObject({ state: 'declined', decisionNote: 'Not now' });
    expect((await pat.get(`/v1/platform/support-grants/${fourth.id}/configuration`)).status).toBe(
      403,
    );
    const mine = await pat.get('/v1/platform/support-grants');
    expect(mine.body.items.map((g: { state: string }) => g.state)).toEqual([
      'declined',
      'ended',
      'revoked',
      'expired',
    ]);
  });

  it('keeps each workspace’s grants to itself', async () => {
    const theirs = await requestAccess(pat, otherOwner.tenant as string, {
      scopes: ['configuration'],
    });
    const fresh = await freshOwner();
    expect((await fresh.post(`/v1/admin/support-grants/${theirs.id}/approve`, {})).status).toBe(
      404,
    );
    const approved = await otherOwner.post(`/v1/admin/support-grants/${theirs.id}/approve`, {});
    expect(approved.status).toBe(200);
    const configuration = await pat.get(`/v1/platform/support-grants/${theirs.id}/configuration`);
    expect(configuration.body.members.map((m: { email: string }) => m.email)).toEqual([
      'otto@example.com',
    ]);
    expect(
      (await fresh.get('/v1/admin/support-grants')).body.items.map((g: { id: string }) => g.id),
    ).not.toContain(theirs.id);
    expect((await agent.get('/v1/workspace/notices')).body.supportAccess).toEqual([]);
  });
});

describe('incidents (A17)', () => {
  it('lets platform admins post an incident banner to every workspace and resolve it', async () => {
    const payload = {
      title: 'Slow replies',
      message: 'AI replies take longer than usual. Human replies are not affected.',
      severity: 'degraded',
    };
    expect((await pat.post('/v1/platform/incidents', payload)).status).toBe(403);
    const declared = await ada.post('/v1/platform/incidents', payload);
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    expect(declared.body).toMatchObject({ ...payload, status: 'active' });
    for (const client of [agent, otherOwner]) {
      const notices = await client.get('/v1/workspace/notices');
      expect(notices.body.incidents).toEqual([
        expect.objectContaining({
          id: declared.body.id,
          title: 'Slow replies',
          severity: 'degraded',
        }),
      ]);
    }
    const resolved = await ada.post(`/v1/platform/incidents/${declared.body.id}/resolve`);
    expect(resolved.body).toMatchObject({ status: 'resolved', resolvedAt: expect.any(String) });
    expect((await agent.get('/v1/workspace/notices')).body.incidents).toEqual([]);

    await ageSessions(gw, 'ada@hamnivo.example');
    const stale = await ada.post('/v1/platform/incidents', payload);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
  });

  it('keeps an intact platform audit chain', async () => {
    const result = await gw.owner.transaction((tx) => verifyPlatformAuditChain(tx));
    expect(result).toMatchObject({ ok: true, checked: expect.any(Number) });
    expect(result.ok && result.checked).toBeGreaterThan(10);
  });
});

/** A fresh two-step sign-in for the owner (support.grant needs it). */
async function freshOwner(): Promise<Client> {
  const client = await signInWithTotp(gw, 'nora@example.com', ownerTotp);
  client.tenant = owner.tenant;
  return client;
}
