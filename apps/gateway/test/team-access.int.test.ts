import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { ageSessions, enrolTotp, join, roleIds, tenantWithOwner } from './access-support.js';
import { Client, type Gateway, PASSWORD, signUp, startGateway } from './harness.js';
import { StaffStream } from './inbox-support.js';
import { freePort } from './slice-harness.js';

let gw: Gateway;
let baseUrl: string;
let owner: Client;
let admin: Client;
let roles: Record<string, string>;
const staff: Record<string, string> = {};

type MemberView = {
  id: string;
  email: string;
  status: string;
  manageable: boolean;
  teams: Array<{ id: string; name: string }>;
  grants: Array<{ id: string; role: { key: string }; scope: { type: string } }>;
};

async function members(client: Client): Promise<MemberView[]> {
  const reply = await client.get('/v1/admin/members');
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.items;
}

async function member(client: Client, email: string): Promise<MemberView> {
  const found = (await members(client)).find((m) => m.email === email);
  if (!found) throw new Error(`${email} is not listed`);
  return found;
}

async function audit(client: Client, query: string) {
  const reply = await client.get(`/v1/admin/audit?${query}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body as {
    items: Array<{
      seq: number;
      action: string;
      actor: { type: string; id: string };
      target: { type: string; id: string } | null;
      reason: string | null;
      data: Record<string, any>;
    }>;
    nextBefore: number | null;
  };
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  gw = await startGateway({ STREAM_HEARTBEAT_SECONDS: '1', PUBLIC_API_ORIGIN: baseUrl });
  await gw.app.listen(port, '127.0.0.1');
  const signedUp = await tenantWithOwner(gw, 'Olga Owner', 'olga@example.com', 'olga');
  owner = (await enrolTotp(gw, signedUp, 'olga@example.com')).client;
  roles = await roleIds(owner);
  staff.olga = (await owner.get('/v1/me')).body.current.staffMemberId;
  const amal = await join(gw, owner, 'Amal Admin', 'amal@example.com', roles.admin as string);
  admin = amal.client;
  staff.amal = amal.staffId;
});

afterAll(async () => {
  await gw?.close();
});

describe('members (A02)', () => {
  it('lists teams and whether the viewer may manage each person', async () => {
    const { staffId } = await join(
      gw,
      owner,
      'Bea Agent',
      'bea@example.com',
      roles.agent as string,
    );
    staff.bea = staffId;
    const team = await owner.post('/v1/admin/teams', { name: 'Care' });
    expect(team.status).toBe(201);
    expect(
      (await owner.put(`/v1/admin/teams/${team.body.id}/members`, { staffMemberIds: [staffId] }))
        .status,
    ).toBe(200);

    const seenByAdmin = await members(admin);
    const by = (email: string) => seenByAdmin.find((m) => m.email === email);
    expect(by('bea@example.com')).toMatchObject({
      manageable: true,
      teams: [{ id: team.body.id, name: 'Care' }],
    });
    // The owner holds billing and support access, which an administrator does not.
    expect(by('olga@example.com')?.manageable).toBe(false);
    // Nobody manages themselves.
    expect(by('amal@example.com')?.manageable).toBe(false);
    expect((await member(owner, 'amal@example.com')).manageable).toBe(true);
  });

  it('keeps suspension, removal and role changes within the actor’s own access', async () => {
    // The ceiling alone protects a billing manager: administrators hold no billing.
    const { staffId: pia } = await join(
      gw,
      owner,
      'Pia Billing',
      'pia@example.com',
      roles.billing as string,
    );
    const suspendPia = await admin.patch(`/v1/admin/members/${pia}`, { status: 'suspended' });
    expect(suspendPia.status).toBe(403);
    expect(suspendPia.body.detail).toContain('access you don’t hold yourself');
    expect((await admin.post(`/v1/admin/members/${pia}/remove`, {})).status).toBe(403);
    expect((await member(owner, 'pia@example.com')).status).toBe('active');

    const suspendOwner = await admin.patch(`/v1/admin/members/${staff.olga}`, {
      status: 'suspended',
    });
    expect(suspendOwner.status).toBe(403);
    expect(suspendOwner.body.detail).toContain('access you don’t hold yourself');
    expect((await admin.post(`/v1/admin/members/${staff.olga}/remove`, {})).status).toBe(403);
    const ownerGrant = (await member(owner, 'olga@example.com')).grants[0];
    const demote = await admin.post(`/v1/admin/grants/${ownerGrant?.id}/replace`, {
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(demote.status).toBe(403);
    expect((await owner.post(`/v1/admin/members/${staff.olga}/remove`, {})).status).toBe(422);

    // Within reach: Bea's agent role becomes analyst, in one step, audited from and to.
    const beaGrant = (await member(admin, 'bea@example.com')).grants[0];
    const changed = await admin.post(`/v1/admin/grants/${beaGrant?.id}/replace`, {
      roleId: roles.analyst,
      scope: { type: 'tenant' },
      reason: 'Moved to reporting',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ role: { key: 'analyst' }, scope: { type: 'tenant' } });
    const after = await member(admin, 'bea@example.com');
    expect(after.grants.map((g) => g.role.key)).toEqual(['analyst']);
    const [replaced] = (await audit(owner, 'action=grant.replaced')).items;
    expect(replaced?.data).toMatchObject({
      from: { role: 'agent', grant: beaGrant?.id },
      to: { role: 'analyst' },
    });
    // …but never to a role beyond the administrator's own access.
    const toBilling = await admin.post(`/v1/admin/grants/${changed.body.id}/replace`, {
      roleId: roles.billing,
      scope: { type: 'tenant' },
    });
    expect(toBilling.status).toBe(403);
    expect(toBilling.body.detail).toContain('only grant permissions you hold');
  });

  it('lets an invitation neither undo a suspension nor outlive it', async () => {
    const early = await owner.post('/v1/admin/invitations', {
      email: 'cai@example.com',
      roleId: roles.analyst,
      scope: { type: 'tenant' },
    });
    const { client: cai, staffId } = await join(
      gw,
      owner,
      'Cai Agent',
      'cai@example.com',
      roles.agent as string,
    );
    expect(
      (await admin.patch(`/v1/admin/members/${staffId}`, { status: 'suspended' })).status,
    ).toBe(200);
    const again = await admin.post('/v1/admin/invitations', {
      email: 'cai@example.com',
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(again.status).toBe(422);
    expect(again.body.fields[0].message).toContain('suspended');
    const back = new Client(gw.app);
    await back.post('/api/auth/sign-in/email', { email: 'cai@example.com', password: PASSWORD });
    const accepted = await back.post('/v1/invitations/accept', { token: early.body.token });
    expect(accepted.status).toBe(404);
    expect((await member(owner, 'cai@example.com')).status).toBe('suspended');
    expect((await cai.get('/v1/me')).status).toBe(401);
  });

  it('removes a person: grants revoked, teams left, sessions ended, live streams closed', async () => {
    const { client: dana, staffId } = await join(
      gw,
      owner,
      'Dana Agent',
      'dana@example.com',
      roles.agent as string,
    );
    const teams = await owner.get('/v1/admin/teams');
    const care = teams.body.items.find((t: { name: string }) => t.name === 'Care');
    await owner.put(`/v1/admin/teams/${care.id}/members`, {
      staffMemberIds: [staff.bea, staffId],
    });
    const stream = new StaffStream(baseUrl, dana);
    onTestFinished(() => stream.close());
    expect((await stream.ready).status).toBe(200);
    await stream.until((s) => s.events('control').some((e) => e.control === 'heartbeat'));

    const plan = await admin.get(`/v1/admin/members/${staffId}/offboarding`);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({
      member: { id: staffId, email: 'dana@example.com' },
      openConversations: { total: 0, ids: [] },
      canReassign: true,
      lastOwner: false,
    });
    const removed = await admin.post(`/v1/admin/members/${staffId}/remove`, {
      reason: 'Left the company',
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    await stream.until((s) => s.events('control').some((e) => e.control === 'auth_expired'));
    await stream.until((s) => s.ended);
    expect((await dana.get('/v1/me')).status).toBe(401);
    expect((await members(owner)).map((m) => m.email)).not.toContain('dana@example.com');
    const [event] = (await audit(owner, `action=member.removed&targetId=${staffId}`)).items;
    expect(event).toMatchObject({ reason: 'Left the company', actor: { id: staff.amal } });
    expect(event?.data.grantsRevoked).toHaveLength(1);
    expect(event?.data.teamsLeft).toEqual([care.id]);
    const ended = await audit(owner, `action=member.sessions_ended&targetId=${staffId}`);
    expect(ended.items[0]?.data.sessions).toBeGreaterThan(0);
    const careNow = (await owner.get('/v1/admin/teams')).body.items.find(
      (t: { id: string }) => t.id === care.id,
    );
    expect(JSON.stringify(careNow)).not.toContain(staffId);
    expect((await admin.post(`/v1/admin/members/${staffId}/remove`, {})).status).toBe(404);
  });

  it('ends only this workspace’s access for someone who belongs to another one', async () => {
    const elsewhere = await tenantWithOwner(gw, 'Eli Else', 'eli@example.com', 'eli-else');
    const invited = await owner.post('/v1/admin/invitations', {
      email: 'eli@example.com',
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    const accepted = await elsewhere.post(
      '/v1/invitations/accept',
      { token: invited.body.token },
      { tenant: null },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const here = accepted.body.staffMemberId as string;
    expect((await elsewhere.get('/v1/admin/members', { tenant: owner.tenant })).status).toBe(200);

    expect((await owner.post(`/v1/admin/members/${here}/remove`, {})).status).toBe(204);
    expect((await elsewhere.get('/v1/me')).status).toBe(200);
    expect((await elsewhere.get('/v1/admin/members')).status).toBe(200);
    const gone = await elsewhere.get('/v1/admin/members', { tenant: owner.tenant });
    expect(gone.status).toBe(404);
    expect(await audit(owner, `action=member.sessions_ended&targetId=${here}`)).toMatchObject({
      items: [],
    });

    // Another workspace's owner cannot remove anyone here.
    const outsider = await elsewhere.post(`/v1/admin/members/${staff.bea}/remove`, {});
    expect(outsider.status).toBe(404);
  });

  it('sends an invitation again with a new link, within the sender’s access today', async () => {
    const first = await admin.post('/v1/admin/invitations', {
      email: 'fay@example.com',
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(first.body.invitedBy).toEqual({ id: staff.amal, displayName: 'Amal Admin' });
    const resent = await admin.post(`/v1/admin/invitations/${first.body.id}/resend`);
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body.token).not.toBe(first.body.token);
    expect(gw.mailer.last('fay@example.com', 'members.invitation')?.text).toContain(
      encodeURIComponent(resent.body.token),
    );
    const fay = await signUp(gw, 'Fay', 'fay@example.com');
    expect((await fay.post('/v1/invitations/accept', { token: first.body.token })).status).toBe(
      404,
    );
    expect((await fay.post('/v1/invitations/accept', { token: resent.body.token })).status).toBe(
      200,
    );
    const list = await owner.get('/v1/admin/invitations');
    expect(list.body.items.find((i: { id: string }) => i.id === first.body.id)).toMatchObject({
      status: 'accepted',
      acceptedAt: expect.any(String),
    });

    const forOwner = await owner.post('/v1/admin/invitations', {
      email: 'gil@example.com',
      roleId: roles.owner,
      scope: { type: 'tenant' },
    });
    expect((await admin.post(`/v1/admin/invitations/${forOwner.body.id}/resend`)).status).toBe(403);
    expect((await audit(owner, 'action=invitation.resent')).items).toHaveLength(1);
  });
});

describe('custom roles (A12)', () => {
  let triage: { id: string; version: number };

  it('previews a change: the diff, what is out of reach, and who gains or loses what', async () => {
    const created = await owner.post('/v1/admin/roles', {
      key: 'triage',
      name: 'Triage',
      permissions: ['conversations.read', 'conversations.assign'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ memberCount: 0, editable: true, isPreset: false });
    triage = created.body;
    const { staffId: hana } = await join(gw, owner, 'Hana', 'hana@example.com', triage.id);
    const { staffId: ivo } = await join(gw, owner, 'Ivo', 'ivo@example.com', triage.id);
    const ivoGrant = await owner.post('/v1/admin/grants', {
      staffMemberId: ivo,
      roleId: roles.supervisor,
      scope: { type: 'tenant' },
    });
    expect(ivoGrant.status).toBe(201);

    const preview = await admin.post('/v1/admin/roles/preview', {
      roleId: triage.id,
      permissions: ['conversations.read', 'conversations.export', 'billing.manage'],
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    // Permissions come in catalog order.
    expect(preview.body).toMatchObject({
      added: ['conversations.export', 'billing.manage'],
      removed: ['conversations.assign'],
      addedSensitive: ['conversations.export', 'billing.manage'],
      outsideReach: ['billing.manage'],
      version: 1,
    });
    // Hana loses assigning; Ivo keeps it (and already exports) through his supervisor role.
    expect(preview.body.impact).toEqual([
      {
        staffMemberId: hana,
        displayName: 'Hana',
        gains: ['conversations.export', 'billing.manage'],
        loses: ['conversations.assign'],
      },
      { staffMemberId: ivo, displayName: 'Ivo', gains: ['billing.manage'], loses: [] },
    ]);
    const listed = (await owner.get('/v1/admin/roles')).body.items.find(
      (r: { id: string }) => r.id === triage.id,
    );
    expect(listed.memberCount).toBe(2);

    const { client: agent } = await join(gw, owner, 'Jo', 'jo@example.com', roles.agent as string);
    expect(
      (await agent.post('/v1/admin/roles/preview', { permissions: ['conversations.read'] })).status,
    ).toBe(403);
  });

  it('asks for a fresh sign-in to save, not to preview', async () => {
    await ageSessions(gw, 'amal@example.com');
    const preview = await admin.post('/v1/admin/roles/preview', {
      roleId: triage.id,
      permissions: ['conversations.read'],
    });
    expect(preview.status).toBe(200);
    const save = await admin.patch(`/v1/admin/roles/${triage.id}`, {
      permissions: ['conversations.read'],
      version: triage.version,
    });
    expect(save.status).toBe(401);
    expect(save.body.code).toBe('REAUTH_REQUIRED');
    admin = new Client(gw.app);
    await admin.post('/api/auth/sign-in/email', { email: 'amal@example.com', password: PASSWORD });
    admin.tenant = owner.tenant;
  });

  it('makes roles beyond the editor’s reach read-only to them, and built-in roles to all', async () => {
    const payments = await owner.post('/v1/admin/roles', {
      key: 'payments',
      name: 'Payments',
      permissions: ['billing.manage', 'analytics.read'],
    });
    expect(payments.status).toBe(201);
    const seen = (await admin.get('/v1/admin/roles')).body.items as Array<{
      key: string;
      editable: boolean;
    }>;
    const editable = Object.fromEntries(seen.map((r) => [r.key, r.editable]));
    expect(editable).toMatchObject({ payments: false, triage: true, owner: false, agent: false });
    const edit = await admin.patch(`/v1/admin/roles/${payments.body.id}`, {
      name: 'Payments team',
      version: 1,
    });
    expect(edit.status).toBe(403);
    expect((await admin.delete(`/v1/admin/roles/${payments.body.id}`)).status).toBe(403);
    expect(
      (await owner.patch(`/v1/admin/roles/${roles.agent}`, { name: 'Agent', version: 1 })).status,
    ).toBe(422);
    expect((await owner.delete(`/v1/admin/roles/${roles.agent}`)).status).toBe(422);
    const permissions = await admin.get('/v1/admin/permissions');
    const grantable = Object.fromEntries(
      permissions.body.items.map((p: { key: string; grantable: boolean }) => [p.key, p.grantable]),
    );
    expect(grantable).toMatchObject({
      'conversations.read': true,
      'billing.manage': false,
      'support.grant': false,
    });
  });

  it('retires a role only once nobody holds it or is invited with it', async () => {
    const blocked = await admin.delete(`/v1/admin/roles/${triage.id}`);
    expect(blocked.status).toBe(422);
    for (const email of ['hana@example.com', 'ivo@example.com']) {
      const grant = (await member(owner, email)).grants.find((g) => g.role.key === 'triage');
      expect((await owner.post(`/v1/admin/grants/${grant?.id}/revoke`, {})).status).toBe(204);
    }
    expect((await admin.delete(`/v1/admin/roles/${triage.id}`)).status).toBe(204);
    const keys = (await owner.get('/v1/admin/roles')).body.items.map((r: { key: string }) => r.key);
    expect(keys).not.toContain('triage');
    const invite = await owner.post('/v1/admin/invitations', {
      email: 'kim@example.com',
      roleId: triage.id,
      scope: { type: 'tenant' },
    });
    expect(invite.status).toBe(404);
    const [archived] = (await audit(owner, 'action=role.archived')).items;
    expect(archived?.data).toEqual({ key: 'triage' });
  });
});

describe('audit trail (A09)', () => {
  it('filters by actor, action, target and time, page by page', async () => {
    const byAdmin = await audit(owner, `actorId=${staff.amal}&limit=200`);
    expect(byAdmin.items.length).toBeGreaterThan(3);
    expect(new Set(byAdmin.items.map((e) => e.actor.id))).toEqual(new Set([staff.amal]));
    const onBea = await audit(owner, `targetType=staff&targetId=${staff.bea}`);
    expect(onBea.items.map((e) => e.action)).toEqual(expect.arrayContaining(['grant.replaced']));
    expect(onBea.items.every((e) => e.target?.id === staff.bea)).toBe(true);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await audit(owner, `from=${encodeURIComponent(future)}`)).items).toEqual([]);
    expect((await audit(owner, 'to=2000-01-01T00:00:00.000Z')).items).toEqual([]);
    const first = await audit(owner, 'limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.nextBefore).toBe(first.items[2]?.seq);
    const next = await audit(owner, `limit=3&before=${first.nextBefore}`);
    expect(next.items[0]?.seq).toBe((first.nextBefore as number) - 1);
    expect((await owner.get('/v1/admin/audit?actorType=robot')).status).toBe(422);
  });

  it('exports with its own permission and a fresh sign-in, and records the export', async () => {
    const { client: agent } = await join(gw, owner, 'Lu', 'lu@example.com', roles.agent as string);
    expect((await agent.get('/v1/admin/audit/export')).status).toBe(403);
    const workspaces = await owner.get('/v1/admin/workspaces');
    const main = workspaces.body.items[0];
    const { client: local } = await join(gw, owner, 'Mo', 'mo@example.com', roles.admin as string, {
      type: 'workspace',
      id: main.id,
    });
    expect((await local.get('/v1/admin/audit/export')).status).toBe(403);
    await ageSessions(gw, 'mo@example.com');

    // A credential stored today must not reach any export.
    const secret = `sk_live_${'9'.repeat(24)}`;
    const stored = await owner.post('/v1/admin/secrets', {
      kind: 'test.credential',
      label: 'Payment provider',
      value: secret,
    });
    expect(stored.status, JSON.stringify(stored.body)).toBe(201);
    // Text a spreadsheet would run as a formula comes out inert.
    const grant = (await member(owner, 'lu@example.com')).grants[0];
    await owner.post(`/v1/admin/grants/${grant?.id}/revoke`, {
      reason: '=HYPERLINK("https://evil.example","x")',
    });

    const total = (await audit(owner, 'limit=200')).items.length;
    const ndjson = await admin.get('/v1/admin/audit/export?format=ndjson');
    expect(ndjson.status).toBe(200);
    expect(ndjson.headers['content-type']).toContain('application/x-ndjson');
    expect(ndjson.headers['cache-control']).toBe('no-store');
    expect(String(ndjson.headers['content-disposition'])).toMatch(
      new RegExp(
        `attachment; filename="hamnivo-audit-${owner.tenant}-\\d{4}-\\d{2}-\\d{2}\\.ndjson"`,
      ),
    );
    const events = String(ndjson.body)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(total);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1);
      expect(events[i].prevHash).toBe(events[i - 1].hash);
    }
    expect(String(ndjson.body)).not.toContain(secret);

    const [recorded] = (await audit(owner, 'action=audit.exported')).items;
    expect(recorded).toMatchObject({
      actor: { id: staff.amal },
      data: { format: 'ndjson', filters: {}, events: total },
    });

    const csv = await admin.get('/v1/admin/audit/export?format=csv&action=grant.revoked');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = String(csv.body).trim().split('\r\n');
    expect(lines[0]).toBe(
      'seq,id,occurred_at,actor_type,actor_id,action,target_type,target_id,outcome,reason,request_id,data,prev_hash,hash',
    );
    expect(lines.slice(1).every((line) => line.includes(',grant.revoked,'))).toBe(true);
    expect(String(csv.body)).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(String(csv.body)).not.toContain(secret);

    const stale = await local.get('/v1/admin/audit/export');
    expect(stale.status).toBe(403);
    await ageSessions(gw, 'olga@example.com');
    const reauth = await owner.get('/v1/admin/audit/export');
    expect(reauth.status).toBe(401);
    expect(reauth.body.code).toBe('REAUTH_REQUIRED');
    expect((await owner.get('/v1/admin/audit/verify')).body.ok).toBe(true);
  });
});
