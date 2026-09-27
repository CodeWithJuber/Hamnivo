import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Gateway, signUp, startGateway } from './harness.js';

let gw: Gateway;

beforeAll(async () => {
  gw = await startGateway();
});

afterAll(async () => {
  await gw?.close();
});

describe('platform endpoints', () => {
  it('reports liveness and readiness', async () => {
    const client = new Client(gw.app);
    expect((await client.get('/health/live')).status).toBe(200);
    const ready = await client.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'ok', valkey: 'ok' } });
  });

  it('serves the contract OpenAPI document and hides metrics without a token', async () => {
    const client = new Client(gw.app);
    const doc = await client.get<{ openapi: string; paths: Record<string, unknown> }>(
      '/v1/openapi.json',
    );
    expect(doc.body.openapi).toBe('3.1.0');
    expect(Object.keys(doc.body.paths)).toContain('/v1/admin/grants');
    expect((await client.get('/metrics')).status).toBe(404);
  });

  it('serves Prometheus metrics only with the metrics token', async () => {
    const token = 'metrics-token-0123456789abcdef';
    const metrics = await startGateway({ METRICS_TOKEN: token }, gw.database);
    try {
      const client = new Client(metrics.app);
      await client.get('/health/live');
      const scrape = (authorization?: string) =>
        metrics.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: authorization ? { authorization } : {},
        });
      expect((await scrape()).statusCode).toBe(404);
      expect((await scrape(`Bearer ${token.slice(0, -1)}x`)).statusCode).toBe(404);
      expect((await scrape(token)).statusCode).toBe(404);
      const ok = await scrape(`Bearer ${token}`);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toContain('text/plain');
      expect(ok.body).toContain('hamnivo_process_cpu_user_seconds_total');
      expect(ok.body).toMatch(
        /hamnivo_http_request_duration_seconds_count\{method="GET",route="\/health\/live",status="200"\} [1-9]/,
      );
    } finally {
      await metrics.close();
    }
  });

  it('renders malformed bodies and unknown routes as problem details too', async () => {
    const client = new Client(gw.app);
    const malformed = await gw.app.inject({
      method: 'POST',
      url: '/v1/tenants',
      payload: '{"name":',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    const missing = await client.get('/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers errors as problem details with a request id', async () => {
    const client = new Client(gw.app);
    const reply = await client.get('/v1/me');
    expect(reply.status).toBe(401);
    expect(reply.headers['content-type']).toContain('application/problem+json');
    expect(reply.body).toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });
    expect(String(reply.headers['x-request-id'])).toMatch(/^req_/);
    expect((reply.body as { requestId: string }).requestId).toBe(reply.headers['x-request-id']);
  });
});

describe('staff sign-up and tenant creation', () => {
  it('requires a verified email, then creates a tenant owned by the caller', async () => {
    // Sign-up alone does not sign the person in while the email is unverified.
    const pending = new Client(gw.app);
    await pending.post('/api/auth/sign-up/email', {
      name: 'Pending Person',
      email: 'pending@example.com',
      password: 'correct horse battery staple',
    });
    expect((await pending.get('/v1/me')).status).toBe(401);

    const owner = await signUp(gw, 'Sana Owner', 'sana@example.com');
    const me = await owner.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { email: 'sana@example.com', emailVerified: true, twoFactorEnabled: false },
      memberships: [],
      current: null,
    });

    const created = await owner.post('/v1/tenants', { name: 'Acme Support', slug: 'acme-support' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      tenant: { slug: 'acme-support', status: 'active' },
      status: 'active',
    });
    owner.tenant = created.body.tenant.id;

    const scoped = await owner.get('/v1/me');
    expect(scoped.body.current.permissions).toContain('billing.manage');
    expect(scoped.body.memberships).toHaveLength(1);

    const taken = await owner.post('/v1/tenants', { name: 'Other', slug: 'acme-support' });
    expect(taken.status).toBe(422);
    expect(taken.body.fields).toEqual([{ path: 'slug', message: 'This handle is already taken' }]);

    const audit = await owner.get('/v1/admin/audit');
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(['tenant.created']);
    expect((await owner.get('/v1/admin/audit/verify')).body).toEqual({
      ok: true,
      checked: 1,
      lastSeq: 1,
    });
  });

  it('returns the same tenant when creation is retried with the same Idempotency-Key', async () => {
    const person = await signUp(gw, 'Retry Person', 'retry@example.com');
    const headers = { 'idempotency-key': 'create-tenant-1' };
    const first = await person.post(
      '/v1/tenants',
      { name: 'Retry Co', slug: 'retry-co' },
      { headers },
    );
    const second = await person.post(
      '/v1/tenants',
      { name: 'Retry Co', slug: 'retry-co' },
      { headers },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.tenant.id).toBe(first.body.tenant.id);
  });

  it('hides tenants the caller does not belong to', async () => {
    const outsider = await signUp(gw, 'Outsider', 'outsider@example.com');
    const owner = await signUp(gw, 'Second Owner', 'second@example.com');
    const created = await owner.post('/v1/tenants', { name: 'Private Co', slug: 'private-co' });
    const reply = await outsider.get('/v1/admin/members', { tenant: created.body.tenant.id });
    expect(reply.status).toBe(404);
    expect((await outsider.get('/v1/admin/members', { tenant: 'tnt_not-a-real-id' })).status).toBe(
      404,
    );
  });
});
