import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  closeDb,
  createDb,
  type Db,
  fromPublicId,
  schema,
  setPlatformOperator,
  withTenant,
} from '@hamnivo/db';
import { createTestDatabase, type TestDatabase } from '@hamnivo/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BillingLifecycleService } from '../src/billing/lifecycle.service.js';
import { BillingOperations } from '../src/billing/operations.js';
import { enrolTotp, roleIds } from './access-support.js';
import { Client, type Gateway, PASSWORD, signUp, startGateway } from './harness.js';

/**
 * Sign-up controls and the plans new workspaces start on (SaaS item 1): the sign-up switch and
 * its exceptions, the console's override, Cloudflare Turnstile, the default free plan with its
 * escape hatch, and trials that fall back to free.
 */

let database: TestDatabase;
let closed: Gateway;
let platform: Db;
let app: Db;
let operations: BillingOperations;

async function createWorkspace(client: Client, name: string, slug: string) {
  const created = await client.post('/v1/tenants', { name, slug });
  if (created.status === 201) client.tenant = created.body.tenant.id;
  return created;
}

beforeAll(async () => {
  database = await createTestDatabase(inject('templateDatabase'));
  closed = await startGateway(
    { HAMNIVO_PUBLIC_SIGNUP: 'false', HAMNIVO_DEFAULT_PLAN: 'free' },
    database,
  );
  platform = createDb(database.platform, { max: 1 });
  app = createDb(database.app, { max: 1 });
  operations = new BillingOperations({ platform, app, operator: 'ops', dueDays: 14 });
});

afterAll(async () => {
  await closed?.close();
  if (platform) await closeDb(platform);
  if (app) await closeDb(app);
  await database?.drop();
});

describe('the sign-up switch', () => {
  let owner: Client;

  it('still lets a new server create its first account and its first workspace', async () => {
    expect((await new Client(closed.app).get('/v1/signup')).body).toEqual({
      open: false,
      turnstileSiteKey: null,
    });
    owner = await signUp(closed, 'Nora Owner', 'nora@example.com');
    const created = await createWorkspace(owner, 'Northwind', 'northwind');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The creator gets a welcome email, as HTML with a plain-text version.
    const welcome = closed.mailer.last('nora@example.com', 'tenants.welcome');
    expect(welcome?.subject).toBe('Your workspace Northwind is ready');
    expect(welcome?.html).toContain('Open Studio');
    expect(welcome?.text).toContain('http://localhost:5173/overview');
  });

  it('refuses everyone else, except people invited to a workspace', async () => {
    const stranger = await new Client(closed.app).post('/api/auth/sign-up/email', {
      name: 'Sam Stranger',
      email: 'sam@example.com',
      password: PASSWORD,
    });
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('SIGNUP_CLOSED');

    const roles = await roleIds(owner);
    const invited = await owner.post('/v1/admin/invitations', {
      email: 'ines@example.com',
      roleId: roles.agent,
      scope: { type: 'tenant' },
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const ines = await signUp(closed, 'Ines Invited', 'ines@example.com');
    expect((await ines.post('/v1/invitations/accept', { token: invited.body.token })).status).toBe(
      200,
    );
    // Joining is not opening a workspace of one's own.
    const own = await createWorkspace(ines, 'Ines Co', 'ines-co');
    expect(own.status).toBe(403);
    expect(own.body).toMatchObject({ code: 'FEATURE_DISABLED', reason: 'signup_closed' });
  });

  it('can be opened and closed again from the platform console, which overrides the server', async () => {
    await setPlatformOperator(closed.owner, { email: 'nora@example.com', role: 'platform_admin' });
    const admin = (await enrolTotp(closed, owner, 'nora@example.com')).client;
    expect((await admin.get('/v1/platform/signup')).body).toMatchObject({
      open: false,
      envDefault: false,
      overridden: false,
      turnstile: false,
      defaultPlan: 'free',
    });
    const opened = await admin.put('/v1/platform/signup', { open: true });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ open: true, overridden: true });
    expect((await new Client(closed.app).get('/v1/signup')).body.open).toBe(true);
    const sam = await signUp(closed, 'Sam Stranger', 'sam@example.com');
    expect((await createWorkspace(sam, 'Sam Co', 'sam-co')).status).toBe(201);

    // Back to the server's setting (closed): recorded, and audited on the platform.
    const reset = await admin.put('/v1/platform/signup', { open: null });
    expect(reset.body).toMatchObject({ open: false, overridden: false });
    const late = await new Client(closed.app).post('/api/auth/sign-up/email', {
      name: 'Lee Late',
      email: 'lee@example.com',
      password: PASSWORD,
    });
    expect(late.status).toBe(403);
    const audit = await admin.get('/v1/platform/audit?limit=20');
    expect(
      audit.body.items.filter((e: { action: string }) => e.action === 'platform.signup_changed'),
    ).toHaveLength(2);
    // A workspace owner who is no platform operator has no say over it.
    expect((await new Client(closed.app).put('/v1/platform/signup', { open: true })).status).toBe(
      401,
    );
  });
});

describe('the plan a new workspace starts on', () => {
  it('is the free plan, with limits', async () => {
    const owner = new Client(closed.app);
    const signedIn = await owner.post('/api/auth/sign-in/email', {
      email: 'sam@example.com',
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const me = await owner.get('/v1/me');
    owner.tenant = me.body.memberships[0].tenant.id;
    const billing = await owner.get('/v1/admin/billing');
    expect(billing.body.plan).toMatchObject({ key: 'free', name: 'Free', priceMinor: '0' });
    expect(billing.body.usage.limited).toBe(true);
    expect(billing.body.plan.limits).toMatchObject({ seats: 2, webhookEndpoints: 1 });
    const subscription = await owner.get('/v1/admin/billing/subscription');
    expect(subscription.body).toMatchObject({
      provider: 'free',
      status: 'none',
      plan: { key: 'free' },
      trialEndsAt: null,
      canUpgrade: false,
      canManage: false,
    });
  });

  it('is a trial of the default plan when it has trial days, which falls back to free', async () => {
    await operations.setPlan({
      key: 'pro',
      name: 'Pro',
      currency: 'USD',
      priceMinor: '4900',
      limits: { seats: 10, conversations: 2000 },
      trialDays: 14,
    });
    const trialGateway = await startGateway({ HAMNIVO_DEFAULT_PLAN: 'pro' }, database);
    try {
      const tia = await signUp(trialGateway, 'Tia Trial', 'tia@example.com');
      expect((await createWorkspace(tia, 'Tia Co', 'tia-co')).status).toBe(201);
      const subscription = await tia.get('/v1/admin/billing/subscription');
      expect(subscription.body.plan).toEqual({ key: 'pro', name: 'Pro' });
      const ends = Date.parse(subscription.body.trialEndsAt);
      expect(Math.abs(ends - (Date.now() + 14 * 86_400_000))).toBeLessThan(60_000);

      const tenantId = fromPublicId('tenant', tia.tenant as string);
      {
        const early = new BillingLifecycleService(app, null as never, () => new Date());
        expect(await early.processLapses()).toEqual({ trials: 0, graces: 0 });
        const later = new BillingLifecycleService(
          app,
          null as never,
          () => new Date(Date.now() + 15 * 86_400_000),
        );
        expect(await later.processLapses()).toEqual({ trials: 1, graces: 0 });
        expect(await later.processLapses()).toEqual({ trials: 0, graces: 0 });
        const entitlement = await withTenant(app, { tenantId }, async (tx) => {
          const [row] = await tx.select().from(schema.tenantEntitlements);
          return row;
        });
        expect(entitlement).toMatchObject({ planKey: 'free', trialEndsAt: null });
        const audit = await tia.get('/v1/admin/audit?action=billing.plan_assigned&limit=10');
        expect(audit.body.items.map((e: { data: { source: string } }) => e.data.source)).toEqual([
          'trial_ended',
          'default',
        ]);
      }
    } finally {
      await trialGateway.close();
    }
  });

  it('is none at all with HAMNIVO_DEFAULT_PLAN=unlimited (self-hosting)', async () => {
    const selfHosted = await startGateway({ HAMNIVO_DEFAULT_PLAN: 'unlimited' }, database);
    try {
      const una = await signUp(selfHosted, 'Una Unlimited', 'una@example.com');
      expect((await createWorkspace(una, 'Una Co', 'una-co')).status).toBe(201);
      const billing = await una.get('/v1/admin/billing');
      expect(billing.body).toMatchObject({ plan: null, standing: 'no_plan' });
      expect(billing.body.usage.limited).toBe(false);
    } finally {
      await selfHosted.close();
    }
  });
});

describe('Cloudflare Turnstile on sign-up', () => {
  let verifier: Server;
  const seen: { secret?: string; response?: string }[] = [];

  beforeAll(async () => {
    verifier = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          secret?: string;
          response?: string;
        };
        seen.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            body.response === 'good-token'
              ? { success: true, hostname: 'localhost', action: 'sign-up' }
              : { success: false, 'error-codes': ['invalid-input-response'] },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => verifier.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => verifier?.close(() => resolve()));
  });

  it('asks for a Turnstile token when its keys are set, and checks it with Cloudflare', async () => {
    const port = (verifier.address() as AddressInfo).port;
    const guarded = await startGateway(
      {
        HAMNIVO_PUBLIC_SIGNUP: 'false',
        TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${port}/turnstile/v0/siteverify`,
      },
      database,
    );
    try {
      const visitor = new Client(guarded.app);
      expect((await visitor.get('/v1/signup')).body).toEqual({
        open: false,
        turnstileSiteKey: '0x4AAAAAAA-site',
      });
      const body = { name: 'Tom Turnstile', email: 'tom@example.com', password: PASSWORD };
      const missing = await visitor.post('/api/auth/sign-up/email', body);
      expect(missing.status).toBe(400);
      const wrong = await visitor.post('/api/auth/sign-up/email', body, {
        headers: { 'x-captcha-response': 'bad-token' },
      });
      expect(wrong.status).toBe(403);
      expect(guarded.mailer.last('tom@example.com')).toBeUndefined();
      // Checked before the sign-up switch: a good token still meets the closed switch.
      const closedSwitch = await visitor.post('/api/auth/sign-up/email', body, {
        headers: { 'x-captcha-response': 'good-token' },
      });
      expect(closedSwitch.status).toBe(403);
      expect(closedSwitch.body.code).toBe('SIGNUP_CLOSED');
      expect(seen.map((s) => [s.secret, s.response])).toEqual([
        ['0x4AAAAAAA-secret', 'bad-token'],
        ['0x4AAAAAAA-secret', 'good-token'],
      ]);
    } finally {
      await guarded.close();
    }
    const open = await startGateway(
      {
        HAMNIVO_PUBLIC_SIGNUP: 'true',
        TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
        TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${port}/turnstile/v0/siteverify`,
      },
      database,
    );
    try {
      const created = await new Client(open.app).post(
        '/api/auth/sign-up/email',
        { name: 'Tom Turnstile', email: 'tom@example.com', password: PASSWORD },
        { headers: { 'x-captcha-response': 'good-token' } },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(open.mailer.last('tom@example.com', 'auth.verify-email')?.html).toContain(
        'Confirm email',
      );
    } finally {
      await open.close();
    }
  });
});
