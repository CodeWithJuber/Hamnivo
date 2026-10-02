import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTwoStep } from './developer-support.js';
import { type Client, type Gateway, signUp, startGateway } from './harness.js';

let gw: Gateway;
let owner: Client;
let admin: Client;
let other: Client;
/** Moves the gateway clock (step-up age, key expiry, rate-limit windows). */
let offset = 0;
const MINUTE = 60_000;

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` }, tenant: null });

async function createKey(
  client: Client,
  body: Record<string, unknown> = {},
): Promise<{ id: string; secret: string; prefix: string }> {
  const created = await client.post('/v1/admin/api-keys', {
    name: 'Reporting',
    permissions: ['webhooks.read'],
    expiresInDays: 30,
    ...body,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

beforeAll(async () => {
  gw = await startGateway({ API_KEY_RATE_LIMIT_PER_MINUTE: '8' }, undefined, {
    clock: () => new Date(Date.now() + offset),
  });
  owner = await signUp(gw, 'Key Owner', 'keys-owner@example.com');
  owner.tenant = (
    await owner.post('/v1/tenants', { name: 'Keys Co', slug: 'keys-co' })
  ).body.tenant.id;
  other = await signUp(gw, 'Other Owner', 'keys-other@example.com');
  other.tenant = (
    await other.post('/v1/tenants', { name: 'Other Co', slug: 'keys-other' })
  ).body.tenant.id;
});

afterAll(async () => {
  await gw?.close();
});

describe('API key management', () => {
  it('needs two-step verification and a fresh sign-in', async () => {
    const denied = await owner.post('/v1/admin/api-keys', {
      name: 'x',
      permissions: ['webhooks.read'],
      expiresInDays: 1,
    });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('MFA_REQUIRED');
    // Reading is allowed without it.
    expect((await owner.get('/v1/admin/api-keys')).status).toBe(200);

    admin = await withTwoStep(gw.app, owner, 'keys-owner@example.com');
    offset = 20 * MINUTE;
    const stale = await admin.post('/v1/admin/api-keys', {
      name: 'x',
      permissions: ['webhooks.read'],
      expiresInDays: 1,
    });
    offset = 0;
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
  });

  it('shows the secret once, stores only its HMAC and audits without it', async () => {
    const created = await createKey(admin);
    expect(created.secret).toMatch(/^hv_live_[0-9a-z]{12}_[0-9A-Za-z]{43}$/);
    expect(created.secret.startsWith(`${created.prefix}_`)).toBe(true);
    expect(created).toMatchObject({ status: 'active', permissions: ['webhooks.read'] });

    const list = await admin.get('/v1/admin/api-keys');
    expect(list.body.items.map((k: { id: string }) => k.id)).toContain(created.id);
    expect(JSON.stringify(list.body)).not.toContain(created.secret.split('_').at(-1));

    const tenantId = fromPublicId('tenant', admin.tenant as string);
    const secretPart = created.secret.split('_').at(-1) as string;
    await withTenant(gw.owner, { tenantId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, fromPublicId('apiKey', created.id)));
      expect(row?.secretHash.length).toBe(32);
      expect(row?.secretHash.toString('utf8')).not.toContain(secretPart);
      // The secret is nowhere in the tenant's data: not in keys, audit or idempotency records.
      const { rows } = await tx.execute(
        sql`select count(*)::int as n from (
              select to_jsonb(a)::text as t from audit_events a
              union all select to_jsonb(k)::text from api_keys k
              union all select to_jsonb(i)::text from idempotency_keys i
            ) all_rows where t like ${`%${secretPart}%`}`,
      );
      expect((rows[0] as { n: number }).n).toBe(0);
    });
    const audit = await admin.get('/v1/admin/audit?action=api_key.created');
    expect(audit.body.items[0].data).toMatchObject({
      name: 'Reporting',
      prefix: created.prefix,
      permissions: ['webhooks.read'],
    });
  });

  it('never gives a key more than its creator could, or a permission it cannot use', async () => {
    const workspaces = await admin.get('/v1/admin/workspaces');
    const scoped = await admin.post('/v1/admin/api-keys', {
      name: 'Bad',
      permissions: ['billing.read'],
      scope: { type: 'workspace', id: workspaces.body.items[0].id },
      expiresInDays: 5,
    });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(422);
    expect(scoped.body.fields[0].path).toBe('permissions');
    // Analytics may be scoped to a workspace.
    const analytics = await admin.post('/v1/admin/api-keys', {
      name: 'Workspace reports',
      permissions: ['analytics.read'],
      scope: { type: 'workspace', id: workspaces.body.items[0].id },
      expiresInDays: 5,
    });
    expect(analytics.status, JSON.stringify(analytics.body)).toBe(201);
    expect(analytics.body.scope).toEqual({ type: 'workspace', id: workspaces.body.items[0].id });
    const unknown = await admin.post('/v1/admin/api-keys', {
      name: 'Bad',
      permissions: ['api_keys.manage'],
      expiresInDays: 5,
    });
    expect(unknown.status).toBe(422);
    const permissions = await admin.get('/v1/admin/api-keys/permissions');
    expect(permissions.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'webhooks.read', grantable: true }),
      ]),
    );
  });
});

describe('calling with an API key', () => {
  it('acts in its own tenant with its own permissions only', async () => {
    const key = await createKey(admin);
    const current = await admin.get('/v1/api-keys/current', bearer(key.secret));
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({
      id: key.id,
      tenantId: admin.tenant,
      permissions: ['webhooks.read'],
    });

    expect((await admin.get('/v1/admin/webhooks/endpoints', bearer(key.secret))).status).toBe(200);
    const billing = await admin.get('/v1/admin/billing', bearer(key.secret));
    expect(billing.status).toBe(403);
    expect(billing.body.code).toBe('SCOPE_DENIED');
    // Changes are for people: a key is refused even where its permission would be enough.
    const create = await admin.post(
      '/v1/admin/webhooks/endpoints',
      { url: 'https://hooks.example.com/x', eventTypes: ['order.created'] },
      bearer(key.secret),
    );
    expect(create.status).toBe(401);
    const keys = await admin.get('/v1/admin/api-keys', bearer(key.secret));
    expect(keys.status).toBe(401);
    // Another tenant's header is not a way in.
    const foreign = await admin.get('/v1/admin/webhooks/endpoints', {
      headers: {
        authorization: `Bearer ${key.secret}`,
        'x-hamnivo-tenant': other.tenant as string,
      },
      tenant: null,
    });
    expect(foreign.status).toBe(404);
    const used = await admin.get('/v1/admin/api-keys');
    expect(used.body.items.find((k: { id: string }) => k.id === key.id).lastUsedAt).not.toBeNull();
  });

  it('refuses made-up, altered and unknown keys alike', async () => {
    const key = await createKey(admin);
    const altered = `${key.secret.slice(0, -1)}${key.secret.endsWith('a') ? 'b' : 'a'}`;
    for (const value of [
      altered,
      'hv_live_0000000000000000_abc',
      `${key.prefix}_${'x'.repeat(43)}`,
    ]) {
      const response = await admin.get('/v1/api-keys/current', bearer(value));
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTH_REQUIRED');
      expect(JSON.stringify(response.body)).not.toContain('revoked');
    }
    // A staff session is not accepted on the key-only route.
    expect((await admin.get('/v1/api-keys/current')).status).toBe(401);
  });

  it('keeps other tenants away from the keys', async () => {
    const key = await createKey(admin);
    const list = await other.get('/v1/admin/api-keys');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    const otherAdmin = await withTwoStep(gw.app, other, 'keys-other@example.com');
    const revoke = await otherAdmin.post(`/v1/admin/api-keys/${key.id}/revoke`);
    expect(revoke.status).toBe(404);
    expect((await admin.get('/v1/api-keys/current', bearer(key.secret))).status).toBe(200);
  });

  it('limits the requests of each key per minute', async () => {
    const key = await createKey(admin);
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<Client['get']>> | undefined;
    for (let i = 0; i < 9; i += 1) {
      const response = await admin.get('/v1/api-keys/current', bearer(key.secret));
      statuses.push(response.status);
      if (response.status === 429) limited = response;
    }
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(429);
    expect(limited?.body).toMatchObject({
      code: 'RATE_LIMITED',
      quota: { scope: 'api_key', limit: 'requestsPerMinute', max: 8 },
    });
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
    // Another key has its own budget.
    const fresh = await createKey(admin);
    expect((await admin.get('/v1/api-keys/current', bearer(fresh.secret))).status).toBe(200);
  });
});

describe('rotation and revocation', () => {
  it('keeps the old key working for the overlap only', async () => {
    const key = await createKey(admin);
    const rotated = await admin.post(`/v1/admin/api-keys/${key.id}/rotate`, { overlapMinutes: 30 });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect(rotated.body.secret).not.toBe(key.secret);
    expect(rotated.body.permissions).toEqual(['webhooks.read']);
    const list = await admin.get('/v1/admin/api-keys');
    const old = list.body.items.find((k: { id: string }) => k.id === key.id);
    expect(old).toMatchObject({ status: 'rotating', replacedBy: rotated.body.id });

    expect((await admin.get('/v1/api-keys/current', bearer(key.secret))).status).toBe(200);
    expect((await admin.get('/v1/api-keys/current', bearer(rotated.body.secret))).status).toBe(200);
    // A key being replaced cannot be rotated again.
    expect((await admin.post(`/v1/admin/api-keys/${key.id}/rotate`, {})).status).toBe(409);

    offset = 31 * MINUTE;
    const expired = await admin.get('/v1/api-keys/current', bearer(key.secret));
    const current = await admin.get('/v1/api-keys/current', bearer(rotated.body.secret));
    offset = 0;
    expect(expired.status).toBe(401);
    expect(expired.body.detail).toMatch(/expired/);
    expect(current.status).toBe(200);
    const audit = await admin.get('/v1/admin/audit?action=api_key.rotated');
    expect(audit.body.items[0].data).toMatchObject({
      replacedBy: rotated.body.id,
      overlapMinutes: 30,
    });
  });

  it('stops a revoked key at once and an expired key at its date', async () => {
    const key = await createKey(admin, { expiresInDays: 1 });
    const revoked = await createKey(admin);
    const response = await admin.post(`/v1/admin/api-keys/${revoked.id}/revoke`);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('revoked');
    const refused = await admin.get('/v1/api-keys/current', bearer(revoked.secret));
    expect(refused.status).toBe(401);
    expect(refused.body.detail).toMatch(/revoked/);

    offset = 25 * 60 * MINUTE;
    const late = await admin.get('/v1/api-keys/current', bearer(key.secret));
    offset = 0;
    expect(late.status).toBe(401);
    expect(late.body.detail).toMatch(/expired/);
    const audit = await admin.get('/v1/admin/audit?action=api_key.revoked');
    expect(audit.body.items[0].target.id).toBe(revoked.id);
  });
});
