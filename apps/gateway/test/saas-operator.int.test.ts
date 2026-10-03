import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  closeDb,
  createDb,
  type Db,
  fromPublicId,
  schema,
  setPlatformOperator,
  withTenant,
} from '@hamnivo/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingOperations } from '../src/billing/operations.js';
import { enrolTotp } from './access-support.js';
import { Client, signUp } from './harness.js';
import { type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Running workspaces for customers (SaaS items 2 to 4): the operator API a billing system such
 * as WHMCS calls (create, suspend, unsuspend, terminate, change package) with keys stored as
 * hashes, the platform console's plan and state controls, what a suspended workspace looks like
 * from inside and on the website, and the automatic Chatwoot set-up with its retries.
 */

let slice: Slice;
let platform: Db;
let admin: Client;
let operatorKey = '';

const ACCOUNT = {
  externalRef: 'whmcs:1001',
  name: 'Acme Support',
  owner: { email: 'olivia@acme.example', name: 'Olivia Owner' },
  planKey: 'pro',
  startTrial: true,
  brand: { name: 'Acme', website: 'https://acme.example' },
};

function api(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, key = operatorKey) {
  return slice.gw.app
    .inject({
      method,
      url,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    })
    .then((response) => ({
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    }));
}

/** Makes a workspace's queued automatic set-ups due now (they wait a little after a brand is created). */
async function releaseSetups(tenantId: string) {
  const o = schema.outboxEvents;
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(o)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(and(eq(o.topic, 'chatwoot.provision'), isNull(o.processedAt))),
  );
}

/** The WHMCS module (PHP), driven the way WHMCS calls it; skipped where PHP is not installed. */
const MODULE = fileURLToPath(
  new URL('../../../integrations/whmcs/modules/servers/hamnivo/tests/drive.php', import.meta.url),
);
const hasPhp = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function whmcs(action: string, params: Record<string, unknown>) {
  // Asynchronous on purpose: the gateway answers from this same process.
  const { stdout } = await promisify(execFile)(
    'php',
    [MODULE, JSON.stringify({ action, params })],
    {
      timeout: 60_000,
    },
  );
  return (JSON.parse(stdout) as { result: unknown }).result;
}

const accountsCreated = () =>
  slice.fake.requests.filter((r) => r.method === 'POST' && r.url === '/platform/api/v1/accounts')
    .length;

beforeAll(async () => {
  slice = await startSlice({
    env: {
      HAMNIVO_DEFAULT_PLAN: 'free',
      HAMNIVO_PUBLIC_SIGNUP: 'false',
      CHATWOOT_AUTO_PROVISION: 'true',
      BILLING_PROVIDER: 'whmcs',
      WHMCS_CLIENT_AREA_URL: 'https://billing.example/clientarea.php',
    },
  });
  platform = createDb(slice.gw.database.platform, { max: 1 });
  await new BillingOperations({ platform, app: slice.app, operator: 'ops', dueDays: 14 }).setPlan({
    key: 'pro',
    name: 'Pro',
    currency: 'USD',
    priceMinor: '4900',
    limits: { seats: 10 },
    trialDays: 14,
  });
  // The first account of a new server is always allowed; it becomes the platform operator.
  const person = await signUp(slice.gw, 'Ada Admin', 'ada@hamnivo.example');
  await setPlatformOperator(slice.gw.owner, {
    email: 'ada@hamnivo.example',
    role: 'platform_admin',
  });
  admin = (await enrolTotp(slice.gw, person, 'ada@hamnivo.example')).client;
});

afterAll(async () => {
  if (platform) await closeDb(platform);
  await slice?.close();
});

describe('operator API keys', () => {
  it('are created in the platform console, shown once and stored as a hash', async () => {
    expect((await api('GET', '/v1/operator/ping', undefined, '')).status).toBe(401);
    const created = await admin.post('/v1/platform/operator-keys', { name: 'WHMCS' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    operatorKey = created.body.key;
    expect(operatorKey).toMatch(/^hvop_[0-9a-z]{12}_/);
    const { rows } = await platform.execute<{ secret_hash: Buffer; prefix: string }>(
      sql`select secret_hash, prefix from operator_api_keys`,
    );
    expect(rows).toHaveLength(1);
    expect(operatorKey.startsWith(`${rows[0]?.prefix}_`)).toBe(true);
    expect(rows[0]?.secret_hash.toString('utf8')).not.toContain(operatorKey.split('_').at(-1));
    const listed = await admin.get('/v1/platform/operator-keys');
    expect(listed.body.items).toEqual([
      expect.objectContaining({ name: 'WHMCS', prefix: rows[0]?.prefix, revokedAt: null }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(operatorKey);
    expect(await api('GET', '/v1/operator/ping')).toEqual({
      status: 200,
      body: { ok: true, plans: ['free', 'pro'] },
    });
  });

  it('stop working once revoked, and wrong keys read the same', async () => {
    const spare = await admin.post('/v1/platform/operator-keys', { name: 'Old WHMCS' });
    expect((await api('GET', '/v1/operator/ping', undefined, spare.body.key)).status).toBe(200);
    const revoked = await admin.post(`/v1/platform/operator-keys/${spare.body.id}/revoke`);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await api('GET', '/v1/operator/ping', undefined, spare.body.key)).status).toBe(401);
    expect((await api('GET', '/v1/operator/ping', undefined, `${operatorKey}x`)).status).toBe(401);
    // A workspace API key is not an operator key.
    expect((await api('GET', '/v1/operator/ping', undefined, 'hv_live_abc_def')).status).toBe(401);
  });
});

describe('CreateAccount', () => {
  let ownerClient: Client;

  it('creates the workspace on its plan, safe to repeat, and invites the owner', async () => {
    const created = await api('POST', '/v1/operator/accounts', ACCOUNT);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      externalRef: 'whmcs:1001',
      name: 'Acme Support',
      slug: 'acme-support',
      status: 'active',
      plan: { key: 'pro', name: 'Pro' },
      studioUrl: 'http://localhost:5173/tenants',
    });
    expect(Date.parse(created.body.trialEndsAt)).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    const again = await api('POST', '/v1/operator/accounts', ACCOUNT);
    expect(again.status).toBe(200);
    expect(again.body.tenantId).toBe(created.body.tenantId);
    // The repeat sent the invitation again with a new link; the old one no longer works.
    const invitations = slice.gw.mailer.messages.filter(
      (m) => m.to === 'olivia@acme.example' && m.template === 'members.invitation',
    );
    expect(invitations).toHaveLength(2);
    const last = invitations.at(-1);
    expect(last?.senderName).toBe('Acme Support');
    expect(last?.subject).toBe('You have been invited to Acme Support on Hamnivo');
    expect(last?.html).toContain('Accept invitation');
    const token = decodeURIComponent(/token=(\S+)/.exec(last?.text ?? '')?.[1] ?? '');
    const oldToken = decodeURIComponent(/token=(\S+)/.exec(invitations[0]?.text ?? '')?.[1] ?? '');

    // Sign-up is closed on this server, but an invited owner may create an account.
    ownerClient = await signUp(slice.gw, 'Olivia Owner', 'olivia@acme.example');
    expect((await ownerClient.post('/v1/invitations/accept', { token: oldToken })).status).toBe(
      404,
    );
    const accepted = await ownerClient.post('/v1/invitations/accept', { token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    ownerClient.tenant = created.body.tenantId;
    const me = await ownerClient.get('/v1/me', { tenant: created.body.tenantId });
    expect(me.body.current.permissions).toContain('billing.manage');
    // The system inviter is no member and no seat.
    const members = await ownerClient.get('/v1/admin/members');
    expect(members.body.items.map((m: { email: string }) => m.email)).toEqual([
      'olivia@acme.example',
    ]);
  });

  it('sets up the brand’s Chatwoot account from the tenant.created handler', async () => {
    const queued = await ownerClient.get('/v1/admin/authority/provisioning');
    expect(queued.body.items).toEqual([expect.objectContaining({ state: 'queued' })]);
    await slice.drain();
    const done = await ownerClient.get('/v1/admin/authority/provisioning');
    expect(done.body.items).toEqual([
      expect.objectContaining({ state: 'connected', step: 'done', attempts: 1, lastError: null }),
    ]);
    const connections = await ownerClient.get('/v1/admin/authority/connections');
    expect(connections.body.items).toHaveLength(1);
    expect(connections.body.items[0].inboxes[0].purpose).toBe('live');
  });

  it('gives a name that is taken a handle of its own', async () => {
    const other = await api('POST', '/v1/operator/accounts', {
      ...ACCOUNT,
      externalRef: 'whmcs:1002',
      owner: { email: 'otto@acme.example', name: 'Otto' },
      brand: undefined,
      planKey: undefined,
      startTrial: false,
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.slug).toMatch(/^acme-support-[0-9a-f]{6}$/);
    expect(other.body.plan).toEqual({ key: 'free', name: 'Free' });
  });

  it('shows WHMCS customers their client area for billing', async () => {
    const subscription = await ownerClient.get('/v1/admin/billing/subscription');
    expect(subscription.body).toMatchObject({
      provider: 'whmcs',
      canUpgrade: false,
      canManage: true,
    });
    const portal = await ownerClient.post('/v1/admin/billing/portal');
    expect(portal.body).toEqual({ url: 'https://billing.example/clientarea.php' });
  });

  describe('suspension, plans and termination', () => {
    it('suspends: staff can read, nothing can change, and the widget shows offline', async () => {
      const brands = await ownerClient.get('/v1/admin/brands');
      const widgetId = brands.body.items[0].widgetId as string;
      const visitor = new Visitor(slice.baseUrl, widgetId, 'https://acme.example');
      await visitor.open();

      const suspended = await api('POST', '/v1/operator/accounts/whmcs:1001/suspend', {
        reason: 'Overdue invoice 42',
      });
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      expect(suspended.body.status).toBe('suspended');
      expect((await api('POST', '/v1/operator/accounts/whmcs:1001/suspend', {})).status).toBe(200);

      // Staff: read-only.
      expect((await ownerClient.get('/v1/admin/members')).status).toBe(200);
      const me = await ownerClient.get('/v1/me');
      expect(me.body.memberships[0].tenant.status).toBe('suspended');
      expect(me.body.current.permissions).toContain('conversations.read');
      expect(me.body.current.permissions).not.toContain('brands.manage');
      const write = await ownerClient.post('/v1/admin/brands', {
        workspaceId: (await ownerClient.get('/v1/admin/workspaces')).body.items[0].id,
        name: 'Second',
        allowedOrigins: [],
      });
      expect(write.status).toBe(403);
      expect(write.body).toMatchObject({ code: 'FEATURE_DISABLED', reason: 'workspace_suspended' });
      // …except paying: Manage still opens the client area.
      expect((await ownerClient.post('/v1/admin/billing/portal')).status).toBe(200);

      // The website: the launcher still loads, the chat says it is offline.
      const launcher = await visitor.call('GET', `/v1/widget/launcher?widgetId=${widgetId}`);
      expect(launcher.status).toBe(200);
      const fresh = await new Visitor(slice.baseUrl, widgetId, 'https://acme.example').call(
        'POST',
        '/v1/widget/sessions',
        { widgetId, hostOrigin: 'https://acme.example' },
      );
      expect(fresh.status).toBe(403);
      expect(fresh.body).toMatchObject({ code: 'FEATURE_DISABLED', reason: 'workspace_suspended' });
      const existing = await visitor.call('GET', '/v1/widget/conversations');
      expect(existing.body).toMatchObject({ reason: 'workspace_suspended' });

      const audit = await ownerClient.get('/v1/admin/audit?action=tenant.suspended&limit=10');
      expect(audit.body.items).toHaveLength(1);
      expect(audit.body.items[0]).toMatchObject({ actor: { type: 'platform' } });

      // Back: writes and chats work again.
      const back = await api('POST', '/v1/operator/accounts/whmcs:1001/unsuspend', {});
      expect(back.body.status).toBe('active');
      expect((await visitor.call('GET', '/v1/widget/conversations')).status).toBe(200);
    });

    it('lets the platform console suspend, reactivate, re-plan and show usage', async () => {
      const id = (await api('GET', '/v1/operator/accounts/whmcs:1001')).body.tenantId as string;
      const billing = await admin.get(`/v1/platform/tenants/${id}/billing`);
      expect(billing.status, JSON.stringify(billing.body)).toBe(200);
      expect(billing.body).toMatchObject({
        status: 'active',
        plan: { key: 'pro' },
        provider: 'whmcs',
      });
      expect(billing.body.meters.find((m: { limit: string }) => m.limit === 'seats')).toMatchObject(
        {
          used: 1,
          max: 10,
        },
      );
      expect(
        (await admin.post(`/v1/platform/tenants/${id}/suspend`, { reason: 'Abuse report 7' })).body
          .status,
      ).toBe('suspended');
      expect(
        (await admin.post(`/v1/platform/tenants/${id}/reactivate`, { reason: 'Report closed' }))
          .body.status,
      ).toBe('active');
      const replanned = await admin.put(`/v1/platform/tenants/${id}/plan`, { planKey: 'free' });
      expect(replanned.body).toMatchObject({ plan: { key: 'free' }, trialEndsAt: null });
      const plans = await admin.get('/v1/platform/plans');
      expect(plans.body.items.map((p: { key: string }) => p.key)).toEqual(['free', 'pro']);
      // Platform viewers and workspace owners cannot.
      expect(
        (await ownerClient.put(`/v1/platform/tenants/${id}/plan`, { planKey: 'pro' })).status,
      ).toBe(404);
      const audit = await admin.get('/v1/platform/audit?limit=50');
      const actions = audit.body.items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']));
    });

    it('changes the package, safe to repeat, and terminates for good', async () => {
      const changed = await api('PUT', '/v1/operator/accounts/whmcs:1001/plan', { planKey: 'pro' });
      expect(changed.body.plan).toEqual({ key: 'pro', name: 'Pro' });
      expect(
        (await api('PUT', '/v1/operator/accounts/whmcs:1001/plan', { planKey: 'pro' })).status,
      ).toBe(200);
      expect(
        (await api('PUT', '/v1/operator/accounts/whmcs:1001/plan', { planKey: 'gold' })).status,
      ).toBe(422);
      const audit = await ownerClient.get('/v1/admin/audit?action=billing.plan_assigned&limit=20');
      expect(
        audit.body.items.filter((e: { data: { plan: string } }) => e.data.plan === 'pro'),
      ).toHaveLength(2);

      const closed = await api('POST', '/v1/operator/accounts/whmcs:1001/terminate', {});
      expect(closed.body.status).toBe('closing');
      expect((await api('POST', '/v1/operator/accounts/whmcs:1001/terminate', {})).status).toBe(
        200,
      );
      expect((await api('POST', '/v1/operator/accounts/whmcs:1001/unsuspend', {})).status).toBe(
        409,
      );
      expect((await ownerClient.get('/v1/admin/members')).status).toBe(404);
      expect((await api('GET', '/v1/operator/accounts/whmcs:9999')).status).toBe(404);
    });
  });
});

describe.skipIf(!hasPhp)('the WHMCS provisioning module', () => {
  const service = () => ({
    serverhostname: slice.baseUrl,
    serversecure: '',
    serverpassword: operatorKey,
    serviceid: 77,
    domain: 'wendy.example',
    clientsdetails: {
      firstname: 'Wendy',
      lastname: 'Whmcs',
      email: 'wendy@shop.example',
      companyname: 'Wendy Shop',
    },
    configoption1: 'pro',
    configoption2: '',
    configoption3: 'en',
    configoption4: '',
  });
  const state = async () => (await api('GET', '/v1/operator/accounts/whmcs:77')).body;

  it('creates, suspends, re-plans and terminates through the operator API', async () => {
    expect(await whmcs('TestConnection', service())).toEqual({ success: true, error: '' });
    expect(await whmcs('CreateAccount', service())).toBe('success');
    expect(await state()).toMatchObject({
      externalRef: 'whmcs:77',
      name: 'Wendy Shop',
      status: 'active',
      plan: { key: 'pro' },
      trialEndsAt: null,
    });
    // WHMCS retries a creation whose answer it lost: the same workspace.
    expect(await whmcs('CreateAccount', service())).toBe('success');
    expect(
      slice.gw.mailer.messages.filter((m) => m.to === 'wendy@shop.example').map((m) => m.template),
    ).toEqual(['members.invitation', 'members.invitation']);

    expect(await whmcs('SuspendAccount', { ...service(), suspendreason: 'Overdue' })).toBe(
      'success',
    );
    expect((await state()).status).toBe('suspended');
    expect(await whmcs('UnsuspendAccount', service())).toBe('success');
    expect((await state()).status).toBe('active');

    expect(await whmcs('ChangePackage', { ...service(), configoption1: 'free' })).toBe('success');
    expect((await state()).plan).toEqual({ key: 'free', name: 'Free' });
    expect(await whmcs('ChangePackage', { ...service(), configoption1: 'gold' })).toMatch(
      /^Hamnivo: .*There is no active plan gold/,
    );

    expect(await whmcs('TerminateAccount', service())).toBe('success');
    expect((await state()).status).toBe('closing');
    expect(await whmcs('AdminServicesTabFields', service())).toMatchObject({
      'Hamnivo state': 'closing',
    });
    expect(await whmcs('SuspendAccount', { ...service(), serverpassword: 'hvop_x' })).toMatch(
      /^Hamnivo: /,
    );
  });
});

describe('automatic Chatwoot set-up of a workspace’s first brand', () => {
  async function workspaceWithBrand(label: string) {
    // Platform operators may create workspaces while public sign-up is closed.
    const created = await admin.post('/v1/tenants', { name: `${label} Co`, slug: `${label}-co` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    admin.tenant = created.body.tenant.id;
    const workspaces = await admin.get('/v1/admin/workspaces');
    const brand = await admin.post('/v1/admin/brands', {
      workspaceId: workspaces.body.items[0].id,
      name: `${label} Shop`,
      allowedOrigins: [],
    });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    return { tenantId: fromPublicId('tenant', created.body.tenant.id), brandId: brand.body.id };
  }

  it('runs through the outbox after a short wait, and only for the first brand', async () => {
    const { tenantId, brandId } = await workspaceWithBrand('firstbrand');
    const queued = await admin.get('/v1/admin/authority/provisioning');
    expect(queued.body.items).toEqual([expect.objectContaining({ brandId, state: 'queued' })]);
    // Not yet due: nothing happens on the next pass.
    await slice.drain();
    expect((await admin.get('/v1/admin/authority/provisioning')).body.items[0].state).toBe(
      'queued',
    );
    await releaseSetups(tenantId);
    await slice.drain();
    expect((await admin.get('/v1/admin/authority/provisioning')).body.items[0]).toMatchObject({
      state: 'connected',
    });
    const second = await admin.post('/v1/admin/brands', {
      workspaceId: (await admin.get('/v1/admin/workspaces')).body.items[0].id,
      name: 'Second Shop',
      allowedOrigins: [],
    });
    expect(second.status).toBe(201);
    expect((await admin.get('/v1/admin/authority/provisioning')).body.items).toHaveLength(1);
    // Manual Connect stays for every other brand.
    const connect = await admin.post('/v1/admin/authority/connections', {
      brandId: second.body.id,
    });
    expect(connect.status, JSON.stringify(connect.body)).toBe(201);
  });

  it('continues where a failed attempt stopped, never creating a second account', async () => {
    const before = accountsCreated();
    const { tenantId, brandId } = await workspaceWithBrand('retrying');
    slice.fake.setRequestFault((method, url) =>
      method === 'POST' && url.includes('/agent_bots') ? 503 : null,
    );
    await releaseSetups(tenantId);
    await slice.drain();
    const failed = (await admin.get('/v1/admin/authority/provisioning')).body.items[0];
    expect(failed).toMatchObject({ brandId, state: 'failed', step: 'inbox' });
    expect(failed.lastError).toBe('Chatwoot createAgentBot failed (HTTP 503).');
    expect(accountsCreated()).toBe(before + 1);

    // Manual Connect is the retry: it continues from the bot step.
    slice.fake.setRequestFault(null);
    const connect = await admin.post('/v1/admin/authority/connections', { brandId });
    expect(connect.status, JSON.stringify(connect.body)).toBe(201);
    expect(accountsCreated()).toBe(before + 1);
    expect((await admin.get('/v1/admin/authority/provisioning')).body.items[0]).toMatchObject({
      state: 'connected',
      attempts: failed.attempts + 1,
    });
    // The outbox's own retry then finds it done.
    await releaseSetups(tenantId);
    await slice.drain();
    expect(accountsCreated()).toBe(before + 1);
    const again = await admin.post('/v1/admin/authority/connections', { brandId });
    expect(again.body.id).toBe(connect.body.id);
  });
});
