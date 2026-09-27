import { newPublicId } from '@hamnivo/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Gateway, PASSWORD, signUp, startGateway } from './harness.js';

let gw: Gateway;
let owner: Client;
let roles: Record<string, string>;

async function invite(
  email: string,
  role: string,
  scope: object = { type: 'tenant' },
  grantExpiresAt: string | null = null,
) {
  const reply = await owner.post('/v1/admin/invitations', {
    email,
    roleId: roles[role],
    scope,
    grantExpiresAt,
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body as { id: string; token: string };
}

async function join(
  name: string,
  email: string,
  role: string,
  scope?: object,
  expiry?: string | null,
) {
  const { token } = await invite(email, role, scope, expiry);
  const person = await signUp(gw, name, email);
  const accepted = await person.post('/v1/invitations/accept', { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  person.tenant = owner.tenant;
  return { person, staffId: accepted.body.staffMemberId as string };
}

beforeAll(async () => {
  gw = await startGateway();
  owner = await signUp(gw, 'Sana Owner', 'sana@example.com');
  const created = await owner.post('/v1/tenants', { name: 'Acme', slug: 'acme' });
  owner.tenant = created.body.tenant.id;
  const list = await owner.get('/v1/admin/roles');
  roles = Object.fromEntries(
    list.body.items.map((r: { key: string; id: string }) => [r.key, r.id]),
  );
});

afterAll(async () => {
  await gw?.close();
});

describe('invitations', () => {
  it('lets the invited, verified email address join with the invited role', async () => {
    const { person } = await join('Bilal Agent', 'bilal@example.com', 'agent');
    const me = await person.get('/v1/me');
    expect(me.body.current.permissions).toContain('conversations.reply');
    expect(me.body.current.permissions).not.toContain('billing.manage');
    const members = await person.get('/v1/admin/members');
    expect(members.status).toBe(200);
    expect(members.body.items.map((m: { email: string }) => m.email).sort()).toEqual([
      'bilal@example.com',
      'sana@example.com',
    ]);
    expect(
      (
        await person.post('/v1/admin/roles', {
          key: 'x',
          name: 'X',
          permissions: ['analytics.read'],
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a different account and reused or revoked tokens', async () => {
    const { token } = await invite('dana@example.com', 'agent');
    const intruder = await signUp(gw, 'Intruder', 'intruder@example.com');
    expect((await intruder.post('/v1/invitations/accept', { token })).status).toBe(404);
    const dana = await signUp(gw, 'Dana', 'dana@example.com');
    expect((await dana.post('/v1/invitations/accept', { token: `${token}x` })).status).toBe(404);
    expect((await dana.post('/v1/invitations/accept', { token })).status).toBe(200);
    expect((await dana.post('/v1/invitations/accept', { token })).status).toBe(404);

    const revoked = await invite('eve@example.com', 'agent');
    expect((await owner.delete(`/v1/admin/invitations/${revoked.id}`)).status).toBe(204);
    const eve = await signUp(gw, 'Eve', 'eve@example.com');
    expect((await eve.post('/v1/invitations/accept', { token: revoked.token })).status).toBe(404);
  });
});

describe('delegation ceiling and revocation', () => {
  it('lets a team lead delegate only a subset of their own access inside their team', async () => {
    const team = {
      type: 'team',
      id: (await owner.post('/v1/admin/teams', { name: 'Care' })).body.id,
    };
    const otherTeam = {
      type: 'team',
      id: (await owner.post('/v1/admin/teams', { name: 'Billing' })).body.id,
    };
    const teamLead = await owner.post('/v1/admin/roles', {
      key: 'team_lead',
      name: 'Team lead',
      permissions: ['conversations.read', 'conversations.assign', 'grants.manage', 'members.read'],
    });
    const viewer = await owner.post('/v1/admin/roles', {
      key: 'viewer',
      name: 'Viewer',
      permissions: ['conversations.read'],
    });
    roles.team_lead = teamLead.body.id;
    roles.viewer = viewer.body.id;
    const { person: carol } = await join('Carol Lead', 'carol@example.com', 'team_lead', team);
    const { staffId: frank } = await join('Frank Agent', 'frank@example.com', 'viewer', team);

    const ok = await carol.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: roles.viewer,
      scope: team,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ role: { key: 'viewer' }, scope: team });

    const escalate = await carol.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: roles.agent,
      scope: team,
    });
    expect(escalate.status).toBe(403);
    expect(escalate.body.detail).toContain('only grant permissions you hold');

    const elsewhere = await carol.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: roles.viewer,
      scope: otherTeam,
    });
    expect(elsewhere.status).toBe(403);
    const tenantWide = await carol.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: roles.viewer,
      scope: { type: 'tenant' },
    });
    expect(tenantWide.status).toBe(403);
    const payer = await owner.post('/v1/admin/roles', {
      key: 'payer',
      name: 'Payer',
      permissions: ['billing.manage'],
    });
    const pointless = await owner.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: payer.body.id,
      scope: team,
    });
    expect(pointless.status).toBe(422);
    expect(pointless.body.fields).toEqual([
      { path: 'scope', message: 'This role has no permissions that apply at this level' },
    ]);

    // The owner revokes Carol's team-lead grant; it applies to her very next request.
    const members = await owner.get('/v1/admin/members');
    const carolMember = members.body.items.find(
      (m: { email: string }) => m.email === 'carol@example.com',
    );
    const leadGrant = carolMember.grants.find(
      (g: { role: { key: string } }) => g.role.key === 'team_lead',
    );
    expect(
      (await owner.post(`/v1/admin/grants/${leadGrant.id}/revoke`, { reason: 'Moved team' }))
        .status,
    ).toBe(204);
    const after = await carol.post('/v1/admin/grants', {
      staffMemberId: frank,
      roleId: roles.viewer,
      scope: team,
    });
    expect(after.status).toBe(403);
    expect((await carol.get('/v1/me')).body.current.permissions).toEqual([]);
  });

  it('treats malformed or unknown identifiers as not found', async () => {
    const bad = await owner.post('/v1/admin/grants', {
      staffMemberId: 'stf_01j9zk7w3xq8r4t2v6m5n1p0cd',
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(bad.status).toBe(404);
    const unknown = await owner.post('/v1/admin/grants', {
      staffMemberId: newPublicId('staff').publicId,
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(unknown.status).toBe(404);
  });

  it('keeps tenant-wide data away from workspace-scoped administrators', async () => {
    const workspaces = await owner.get('/v1/admin/workspaces');
    expect(workspaces.status).toBe(200);
    const main = workspaces.body.items.find((w: { slug: string }) => w.slug === 'main');
    const { person: kim } = await join('Kim Workspace Admin', 'kim@example.com', 'admin', {
      type: 'workspace',
      id: main.id,
    });
    expect((await kim.get('/v1/admin/members')).status).toBe(200);
    const audit = await kim.get('/v1/admin/audit');
    expect(audit.status).toBe(403);
    expect(audit.body.detail).toContain('different team, inbox or brand');
    const unknownWorkspace = await owner.post('/v1/admin/invitations', {
      email: 'nobody@example.com',
      roleId: roles.agent,
      scope: { type: 'workspace', id: newPublicId('workspace').publicId },
    });
    expect(unknownWorkspace.status).toBe(404);
  });

  it('never lets a grant outlive the grantor’s own access', async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { person: grace } = await join(
      'Grace Admin',
      'grace@example.com',
      'admin',
      { type: 'tenant' },
      expiresAt,
    );
    const { staffId: hana } = await join('Hana', 'hana@example.com', 'agent');
    const forever = await grace.post('/v1/admin/grants', {
      staffMemberId: hana,
      roleId: roles.analyst,
      scope: { type: 'tenant' },
    });
    expect(forever.status).toBe(403);
    expect(forever.body.detail).toContain('expire no later than your own');
    const bounded = await grace.post('/v1/admin/grants', {
      staffMemberId: hana,
      roleId: roles.analyst,
      scope: { type: 'tenant' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(bounded.status).toBe(201);
  });

  it('suspension takes effect immediately and the last owner is protected', async () => {
    const { person: ivan, staffId: ivanId } = await join('Ivan', 'ivan@example.com', 'agent');
    expect((await ivan.get('/v1/admin/members')).status).toBe(200);
    expect((await owner.patch(`/v1/admin/members/${ivanId}`, { status: 'suspended' })).status).toBe(
      200,
    );
    // Ivan belongs to no other workspace, so the suspension also ended his sessions: a restore
    // later never revives a session that may have been the reason for suspending him.
    const suspended = await ivan.get('/v1/admin/members');
    expect(suspended.status).toBe(401);
    expect(suspended.body.code).toBe('AUTH_REQUIRED');
    expect((await owner.patch(`/v1/admin/members/${ivanId}`, { status: 'active' })).status).toBe(
      200,
    );
    const back = new Client(gw.app);
    await back.post('/api/auth/sign-in/email', { email: 'ivan@example.com', password: PASSWORD });
    back.tenant = owner.tenant;
    expect((await back.get('/v1/admin/members')).status).toBe(200);

    const me = await owner.get('/v1/me');
    const members = await owner.get('/v1/admin/members');
    const ownerGrant = members.body.items
      .find((m: { id: string }) => m.id === me.body.current.staffMemberId)
      .grants.find((g: { role: { key: string } }) => g.role.key === 'owner');
    const self = await owner.post(`/v1/admin/grants/${ownerGrant.id}/revoke`, {});
    expect(self.status).toBe(422);
  });
});

describe('roles', () => {
  it('creates custom roles, audits permission changes and blocks escalation', async () => {
    const created = await owner.post(
      '/v1/admin/roles',
      {
        key: 'triage',
        name: 'Triage',
        permissions: ['conversations.read', 'conversations.assign'],
      },
      { headers: { 'idempotency-key': 'role-triage' } },
    );
    expect(created.status).toBe(201);
    const replay = await owner.post(
      '/v1/admin/roles',
      {
        key: 'triage',
        name: 'Triage',
        permissions: ['conversations.read', 'conversations.assign'],
      },
      { headers: { 'idempotency-key': 'role-triage' } },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(created.body.id);
    const conflict = await owner.post(
      '/v1/admin/roles',
      { key: 'triage2', name: 'Other', permissions: ['conversations.read'] },
      { headers: { 'idempotency-key': 'role-triage' } },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const updated = await owner.patch(`/v1/admin/roles/${created.body.id}`, {
      permissions: ['conversations.read', 'conversations.export'],
      version: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    const stale = await owner.patch(`/v1/admin/roles/${created.body.id}`, {
      name: 'Stale',
      version: 1,
    });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(
      (await owner.patch(`/v1/admin/roles/${roles.owner}`, { name: 'Boss', version: 1 })).status,
    ).toBe(422);
    expect(
      (await owner.post('/v1/admin/roles', { key: 'bad', name: 'Bad', permissions: ['nope.read'] }))
        .status,
    ).toBe(422);

    const audit = await owner.get('/v1/admin/audit?action=role.updated');
    expect(audit.body.items[0].data).toMatchObject({
      added: ['conversations.export'],
      removed: ['conversations.assign'],
      addedSensitive: ['conversations.export'],
    });

    // A workspace admin who lacks billing cannot smuggle it into a role.
    const { person: judy } = await join('Judy Admin', 'judy@example.com', 'admin');
    const smuggle = await judy.post('/v1/admin/roles', {
      key: 'payer2',
      name: 'Payer',
      permissions: ['billing.manage'],
    });
    expect(smuggle.status).toBe(403);
  });

  it('asks for a fresh sign-in before step-up actions', async () => {
    await gw.owner.execute(
      sql`update auth.session set created_at = now() - interval '1 hour' where user_id = (select id from auth.user where email = 'sana@example.com')`,
    );
    const stale = await owner.post('/v1/admin/roles', {
      key: 'late',
      name: 'Late',
      permissions: ['analytics.read'],
    });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    const fresh = new Client(gw.app);
    await fresh.post('/api/auth/sign-in/email', { email: 'sana@example.com', password: PASSWORD });
    fresh.tenant = owner.tenant;
    expect(
      (
        await fresh.post('/v1/admin/roles', {
          key: 'late',
          name: 'Late',
          permissions: ['analytics.read'],
        })
      ).status,
    ).toBe(201);
    owner = fresh;
  });

  it('keeps an intact, verifiable audit trail of all of the above', async () => {
    const verify = await owner.get('/v1/admin/audit/verify');
    expect(verify.body.ok).toBe(true);
    const actions = new Set(
      (await owner.get('/v1/admin/audit?limit=200')).body.items.map(
        (e: { action: string }) => e.action,
      ),
    );
    for (const action of [
      'tenant.created',
      'invitation.created',
      'invitation.accepted',
      'invitation.revoked',
      'grant.created',
      'grant.revoked',
      'member.suspended',
      'member.sessions_ended',
      'member.restored',
      'role.created',
      'role.updated',
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});
