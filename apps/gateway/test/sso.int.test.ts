import { fromPublicId, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DnsResolver } from '../src/identity/sso/dns.js';
import { ageSessions, enrolTotp, join, roleIds, tenantWithOwner } from './access-support.js';
import { Client, CONSOLE_ORIGIN, type Gateway, PASSWORD, signUp, startGateway } from './harness.js';
import { IdpBrowser, type IdpIdentity, startTestIdp, type TestIdp } from './oidc-idp.js';
import { freePort } from './slice-harness.js';

const API_ORIGIN = 'http://localhost:4000';
const DOMAIN = 'northline.example';

/** DNS the tests control: TXT answers by name; `servfail.` names fail like a broken resolver. */
const txt = new Map<string, string[][]>();
const dns: DnsResolver = {
  async resolveTxt(name) {
    const answer = txt.get(name);
    if (answer) return answer;
    const code = name.includes('servfail') ? 'ESERVFAIL' : 'ENOTFOUND';
    throw Object.assign(new Error(`${code} ${name}`), { code });
  },
};

let gw: Gateway;
let idp: TestIdp;
let owner: Client;
let admin: Client;
let rival: Client;
let roles: Record<string, string>;
let domainId: string;
let connection: { id: string; version: number; callbackUrl: string };

function identity(local: string, overrides: Partial<IdpIdentity> = {}): IdpIdentity {
  return {
    sub: `idp-${local}`,
    email: `${local}@${DOMAIN}`,
    emailVerified: true,
    name: local.replace(/^\w/, (c) => c.toUpperCase()),
    ...overrides,
  };
}

/**
 * The whole browser round trip: Studio asks the gateway to start SSO for an address, the browser
 * signs in at the provider, and the provider sends it back to the gateway's callback.
 */
async function ssoSignIn(person: IdpIdentity, client = new Client(gw.app), email = person.email) {
  idp.signInAs(person);
  const start = await client.post('/api/auth/sign-in/sso', {
    email,
    callbackURL: `${CONSOLE_ORIGIN}/`,
    errorCallbackURL: `${CONSOLE_ORIGIN}/sign-in`,
  });
  if (start.status !== 200) return { client, start, done: null, location: null };
  expect(start.body.url.startsWith(`${idp.issuer}/`)).toBe(true);
  const back = await new IdpBrowser().authorize(start.body.url, idp.issuer);
  expect(back.origin).toBe(API_ORIGIN);
  const done = await client.get(`${back.pathname}${back.search}`);
  expect(done.status, JSON.stringify(done.body)).toBe(302);
  return { client, start, done, location: new URL(String(done.headers.location)) };
}

/** Reads the owner's tenant directly, as the database owner (row-level security still applies). */
function inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(gw.owner, { tenantId: fromPublicId('tenant', owner.tenant ?? '') }, work);
}

async function rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return (await gw.owner.execute(query)).rows;
}

async function auditOf(client: Client, action: string) {
  const reply = await client.get(`/v1/admin/audit?action=${action}&limit=50`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.items as Array<{ data: Record<string, unknown>; outcome: string }>;
}

beforeAll(async () => {
  const port = await freePort();
  idp = await startTestIdp({ port, redirectPrefix: `${API_ORIGIN}/api/auth/sso/callback/` });
  gw = await startGateway({ SSO_TRUSTED_IDP_ORIGINS: idp.issuer }, undefined, { dns });
  const signedUp = await tenantWithOwner(gw, 'Nadia Owner', 'nadia@example.com', 'northline');
  owner = (await enrolTotp(gw, signedUp, 'nadia@example.com')).client;
  roles = await roleIds(owner);
  const rivalOwner = await tenantWithOwner(gw, 'Rex Rival', 'rex@example.com', 'rival');
  rival = (await enrolTotp(gw, rivalOwner, 'rex@example.com')).client;
  const invited = await join(gw, owner, 'Rana Admin', 'rana@example.com', roles.admin as string);
  admin = (await enrolTotp(gw, invited.client, 'rana@example.com')).client;
});

afterAll(async () => {
  await gw?.close();
  await idp?.close();
});

describe('proving an email domain (A13)', () => {
  it('needs two-step verification and a fresh sign-in, and is closed to other roles', async () => {
    const plain = await signUp(gw, 'Plain Owner', 'plain@example.com');
    const created = await plain.post('/v1/tenants', { name: 'Plain', slug: 'plain' });
    plain.tenant = created.body.tenant.id;
    const noMfa = await plain.get('/v1/admin/sso');
    expect(noMfa.status).toBe(401);
    expect(noMfa.body.code).toBe('MFA_REQUIRED');

    const { client: agent } = await join(
      gw,
      owner,
      'Adam Agent',
      'adam@example.com',
      roles.agent as string,
    );
    expect((await agent.get('/v1/admin/sso')).status).toBe(403);

    const stale = await enrolTotp(
      gw,
      await signUp(gw, 'Stale', 'stale@example.com'),
      'stale@example.com',
    );
    const staleTenant = await stale.client.post('/v1/tenants', { name: 'Stale', slug: 'stale' });
    stale.client.tenant = staleTenant.body.tenant.id;
    await ageSessions(gw, 'stale@example.com');
    const reauth = await stale.client.post('/v1/admin/sso/domains', { domain: 'stale.example' });
    expect(reauth.status).toBe(401);
    expect(reauth.body.code).toBe('REAUTH_REQUIRED');
  });

  it('verifies a domain only when its TXT record is published', async () => {
    const added = await owner.post('/v1/admin/sso/domains', { domain: 'Northline.Example' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      domain: DOMAIN,
      status: 'pending',
      verification: { name: `_hamnivo-verification.${DOMAIN}` },
    });
    domainId = added.body.id;
    const record = added.body.verification as { name: string; value: string };
    expect(record.value).toMatch(/^hamnivo-verification=[\w-]{20,}$/);
    expect((await owner.post('/v1/admin/sso/domains', { domain: DOMAIN })).status).toBe(422);

    const missing = await owner.post(`/v1/admin/sso/domains/${domainId}/verify`);
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ status: 'pending', lastCheckResult: 'not_found' });

    // Someone else's record at the same name proves nothing.
    txt.set(record.name, [['hamnivo-verification=someone-else']]);
    expect((await owner.post(`/v1/admin/sso/domains/${domainId}/verify`)).body.status).toBe(
      'pending',
    );

    const broken = await owner.post('/v1/admin/sso/domains', { domain: 'servfail.example' });
    const failed = await owner.post(`/v1/admin/sso/domains/${broken.body.id}/verify`);
    expect(failed.body).toMatchObject({ status: 'pending', lastCheckResult: 'lookup_failed' });
    expect((await owner.delete(`/v1/admin/sso/domains/${broken.body.id}`)).status).toBe(204);

    // Long TXT values arrive in 255-byte chunks; the check joins them.
    txt.set(record.name, [['v=spf1 -all'], [record.value.slice(0, 12), record.value.slice(12)]]);
    const verified = await owner.post(`/v1/admin/sso/domains/${domainId}/verify`);
    expect(verified.body).toMatchObject({ status: 'verified', lastCheckResult: 'verified' });
    expect(verified.body.verifiedAt).toEqual(expect.any(String));

    const checks = await auditOf(owner, 'sso.domain_check_failed');
    expect(checks.map((e) => e.data.result).sort()).toEqual([
      'lookup_failed',
      'not_found',
      'not_found',
    ]);
    expect(await auditOf(owner, 'sso.domain_verified')).toHaveLength(1);
  });

  it('never lets another workspace claim a domain this one verified', async () => {
    const claim = await rival.post('/v1/admin/sso/domains', { domain: DOMAIN });
    expect(claim.status).toBe(201);
    // Even with its own record published at the right name, the check fails.
    const record = claim.body.verification as { name: string; value: string };
    txt.set(record.name, [...(txt.get(record.name) ?? []), [record.value]]);
    const attempt = await rival.post(`/v1/admin/sso/domains/${claim.body.id}/verify`);
    expect(attempt.status).toBe(200);
    expect(attempt.body).toMatchObject({ status: 'pending', lastCheckResult: 'claimed_elsewhere' });

    // The rival sees only its own domain and cannot touch this workspace's.
    const settings = await rival.get('/v1/admin/sso');
    expect(settings.body.domains.map((d: { id: string }) => d.id)).toEqual([claim.body.id]);
    expect((await rival.post(`/v1/admin/sso/domains/${domainId}/verify`)).status).toBe(404);
    expect((await rival.delete(`/v1/admin/sso/domains/${domainId}`)).status).toBe(404);
    const connect = await rival.post('/v1/admin/sso/connections', {
      domainId,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    expect(connect.status).toBe(404);
    const own = await rival.post('/v1/admin/sso/connections', {
      domainId: claim.body.id,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    expect(own.status).toBe(422);
    expect(own.body.fields).toEqual([
      { path: 'domainId', message: 'Verify the domain before connecting SSO.' },
    ]);
  });
});

describe('the OpenID Connect connection (A13)', () => {
  it('refuses identity providers on private networks or without HTTPS', async () => {
    for (const issuer of [
      'http://idp.example.com',
      'https://127.0.0.1:8443',
      'https://10.1.2.3',
      'https://localhost:9443',
      'https://[::1]:9443',
      'https://metadata.internal',
    ]) {
      const reply = await owner.post('/v1/admin/sso/connections', {
        domainId,
        issuer,
        clientId: 'x',
        clientSecret: 'y',
      });
      expect(reply.status, issuer).toBe(422);
      expect(reply.body.fields[0].path, issuer).toBe('issuer');
    }
  });

  it('keeps the client secret write-only: stored sealed, shown masked, never audited', async () => {
    const created = await owner.post('/v1/admin/sso/connections', {
      domainId,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      domain: DOMAIN,
      issuer: idp.issuer,
      clientId: idp.clientId,
      status: 'draft',
      ssoOnly: false,
      jitRole: null,
      scopes: ['openid', 'email', 'profile'],
      endpoints: {
        authorization: `${idp.issuer}/auth`,
        token: `${idp.issuer}/token`,
        jwks: `${idp.issuer}/jwks`,
        userInfo: `${idp.issuer}/me`,
      },
    });
    expect(created.body.clientSecret.masked).toBe(`••••${idp.clientSecret.slice(-4)}`);
    expect(created.body.callbackUrl).toBe(`${API_ORIGIN}/api/auth/sso/callback/${created.body.id}`);
    connection = created.body;

    const everywhere = [
      JSON.stringify(created.body),
      JSON.stringify((await owner.get('/v1/admin/sso')).body),
      JSON.stringify((await owner.get('/v1/admin/audit?limit=200')).body),
      JSON.stringify(await inTenant((tx) => tx.select().from(schema.ssoConnections))),
      JSON.stringify(await inTenant((tx) => tx.select().from(schema.secrets))),
    ];
    for (const text of everywhere) expect(text).not.toContain(idp.clientSecret);
    const [sealed] = await inTenant((tx) =>
      tx.select().from(schema.secrets).where(eq(schema.secrets.kind, 'sso_client_secret')),
    );
    expect(sealed?.ciphertext.length).toBeGreaterThan(16);
    expect(sealed?.ciphertext.toString('utf8')).not.toContain(idp.clientSecret);

    expect(
      (
        await owner.post('/v1/admin/sso/connections', {
          domainId,
          issuer: idp.issuer,
          clientId: 'second',
          clientSecret: 'second-secret',
        })
      ).status,
    ).toBe(422);
  });

  it('turns on only when complete, with SSO-only and the member role checked', async () => {
    const early = await owner.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      ssoOnly: true,
    });
    expect(early.status).toBe(422);
    expect(early.body.fields).toEqual([
      { path: 'ssoOnly', message: 'Turn the connection on before requiring SSO.' },
    ]);
    const ownerRole = await owner.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      jitRoleId: roles.owner,
    });
    expect(ownerRole.status).toBe(422);
    expect(ownerRole.body.fields[0].path).toBe('jitRoleId');

    // An administrator cannot hand new members billing, which administrators do not hold.
    const beyond = await admin.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      jitRoleId: roles.billing,
    });
    expect(beyond.status).toBe(403);
    expect(beyond.body.detail).toContain('only grant permissions you hold');

    const on = await admin.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      status: 'active',
      jitRoleId: roles.agent,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ status: 'active', jitRole: { key: 'agent' }, version: 2 });
    connection = on.body;
    const stale = await owner.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: 1,
      ssoOnly: true,
    });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const [updated] = await auditOf(owner, 'sso.connection_updated');
    expect(updated?.data).toMatchObject({
      changes: ['status', 'jitRole'],
      status: 'active',
      jitRole: 'agent',
    });
  });
});

describe('signing in with SSO (A13)', () => {
  it('signs a new person in and adds them with the chosen role', async () => {
    const lina = identity('lina', { name: 'Lina Haddad' });
    const { client, location } = await ssoSignIn(lina);
    expect(location?.href).toBe(`${CONSOLE_ORIGIN}/`);
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: lina.email, emailVerified: true });
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ tenant: expect.objectContaining({ id: owner.tenant }) }),
    ]);
    client.tenant = owner.tenant;
    const scoped = await client.get('/v1/me');
    expect(scoped.body.current.permissions).toContain('conversations.reply');
    expect(scoped.body.current.permissions).not.toContain('security.manage');
    const [joined] = await auditOf(owner, 'member.joined_by_sso');
    expect(joined?.data).toMatchObject({ role: 'agent', domain: DOMAIN });

    // Signing in again finds the same person and the same single membership.
    const again = await ssoSignIn(lina);
    again.client.tenant = owner.tenant;
    expect((await again.client.get('/v1/me')).body.user.id).toBe(me.body.user.id);
    const members = await owner.get('/v1/admin/members');
    expect(
      members.body.items.filter((m: { email: string }) => m.email === lina.email),
    ).toHaveLength(1);
  });

  it('refuses addresses the provider did not verify or that lie outside the domain', async () => {
    const unverified = await ssoSignIn(identity('mona', { emailVerified: false }));
    expect(unverified.location?.searchParams.get('error')).toBe('sso_email_unverified');
    expect(unverified.location?.pathname).toBe('/sign-in');
    const outside = await ssoSignIn(
      identity('mallory', { email: 'mallory@elsewhere.example' }),
      undefined,
      `mallory@${DOMAIN}`,
    );
    expect(outside.location?.searchParams.get('error')).toBe('sso_domain_mismatch');
    for (const email of [`mona@${DOMAIN}`, 'mallory@elsewhere.example']) {
      const users = await rows(sql`select 1 from auth.user where email = ${email}`);
      expect(users, email).toEqual([]);
    }
    expect((await unverified.client.get('/v1/me')).status).toBe(401);
    const refused = await auditOf(owner, 'sso.sign_in_refused');
    expect(refused.map((e) => e.data.code).sort()).toEqual([
      'sso_domain_mismatch',
      'sso_email_unverified',
    ]);
    // What the provider claimed about the person stays out of the audit log.
    expect(JSON.stringify(refused)).not.toContain('mallory@elsewhere.example');
  });

  it('never links an SSO identity to an account whose address was never confirmed', async () => {
    const squatter = new Client(gw.app);
    const created = await squatter.post('/api/auth/sign-up/email', {
      name: 'Squatter',
      email: `omar@${DOMAIN}`,
      password: PASSWORD,
    });
    expect(created.status).toBe(200);
    const omar = identity('omar');
    const attempt = await ssoSignIn(omar);
    expect(attempt.location?.searchParams.get('error')).toBe('sso_unverified_local_account');
    expect((await attempt.client.get('/v1/me')).status).toBe(401);
    const accounts = await rows(
      sql`select a.provider_id from auth.account a join auth.user u on u.id = a.user_id
          where u.email = ${omar.email}`,
    );
    expect(accounts).toEqual([{ provider_id: 'credential' }]);
  });

  it('links to an existing account only when its address was confirmed', async () => {
    const local = await signUp(gw, 'Sara Local', `sara@${DOMAIN}`);
    const before = await local.get('/v1/me');
    const { client } = await ssoSignIn(identity('sara'));
    const after = await client.get('/v1/me');
    expect(after.body.user.id).toBe(before.body.user.id);
    expect(after.body.user.name).toBe('Sara Local');
  });

  it('keeps just-in-time membership within the access of whoever chose the role', async () => {
    const members = await owner.get('/v1/admin/members');
    const rana = members.body.items.find((m: { email: string }) => m.email === 'rana@example.com');
    expect(
      (await owner.patch(`/v1/admin/members/${rana.id}`, { status: 'suspended' })).status,
    ).toBe(200);
    const { client } = await ssoSignIn(identity('zara'));
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([]);
    const [skipped] = await auditOf(owner, 'member.sso_join_skipped');
    expect(skipped?.outcome).toBe('denied');
    expect((await owner.patch(`/v1/admin/members/${rana.id}`, { status: 'active' })).status).toBe(
      200,
    );
  });

  it('opens only the sign-in and callback paths of the SSO plugin', async () => {
    const anyone = new Client(gw.app);
    expect((await anyone.post('/api/auth/sso/register', { providerId: 'x' })).status).toBe(404);
    expect((await anyone.get('/api/auth/sso/providers')).status).toBe(404);
    expect((await anyone.post('/api/auth/sso/verify-domain', {})).status).toBe(404);
    expect((await anyone.get('/api/auth/sso/saml2/sp/metadata')).status).toBe(404);
    const unknown = await anyone.post('/api/auth/sign-in/sso', {
      email: 'someone@unknown.example',
      callbackURL: `${CONSOLE_ORIGIN}/`,
    });
    expect(unknown.status).toBe(404);
  });
});

describe('SSO only (A13)', () => {
  it('refuses passwords, sign-ups and password resets for the domain, and nothing else', async () => {
    const on = await owner.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      ssoOnly: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    connection = on.body;

    const password = await new Client(gw.app).post('/api/auth/sign-in/email', {
      email: `sara@${DOMAIN}`,
      password: PASSWORD,
    });
    expect(password.status).toBe(403);
    expect(password.body.code).toBe('SSO_REQUIRED');
    const upper = await new Client(gw.app).post('/api/auth/sign-in/email', {
      email: `SARA@${DOMAIN.toUpperCase()}`,
      password: PASSWORD,
    });
    expect(upper.body.code).toBe('SSO_REQUIRED');
    const signUpAttempt = await new Client(gw.app).post('/api/auth/sign-up/email', {
      name: 'New',
      email: `new@${DOMAIN}`,
      password: PASSWORD,
    });
    expect(signUpAttempt.body.code).toBe('SSO_REQUIRED');
    const reset = await new Client(gw.app).post('/api/auth/request-password-reset', {
      email: `sara@${DOMAIN}`,
      redirectTo: `${CONSOLE_ORIGIN}/reset-password`,
    });
    expect(reset.status).toBe(200);
    expect(gw.mailer.last(`sara@${DOMAIN}`, 'auth.reset-password')).toBeUndefined();

    // SSO still works, and other domains keep their passwords.
    const sso = await ssoSignIn(identity('sara'));
    expect((await sso.client.get('/v1/me')).status).toBe(200);
    const elsewhere = await new Client(gw.app).post('/api/auth/sign-in/email', {
      email: 'plain@example.com',
      password: PASSWORD,
    });
    expect(elsewhere.status).toBe(200);
  });

  it('lifts the requirement when the connection is turned off, and SSO stops', async () => {
    const off = await owner.patch(`/v1/admin/sso/connections/${connection.id}`, {
      version: connection.version,
      status: 'disabled',
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ status: 'disabled', ssoOnly: false });
    connection = off.body;
    const password = await new Client(gw.app).post('/api/auth/sign-in/email', {
      email: `sara@${DOMAIN}`,
      password: PASSWORD,
    });
    expect(password.status).toBe(200);
    const sso = await ssoSignIn(identity('sara'));
    expect(sso.start.status).toBe(404);
  });

  it('frees the domain when the connection and domain are removed', async () => {
    expect((await owner.delete(`/v1/admin/sso/domains/${domainId}`)).status).toBe(422);
    expect((await owner.delete(`/v1/admin/sso/connections/${connection.id}`)).status).toBe(204);
    const [secret] = await inTenant((tx) =>
      tx
        .select({ revokedAt: schema.secrets.revokedAt })
        .from(schema.secrets)
        .where(eq(schema.secrets.kind, 'sso_client_secret')),
    );
    expect(secret?.revokedAt).toBeInstanceOf(Date);
    expect((await owner.delete(`/v1/admin/sso/domains/${domainId}`)).status).toBe(204);
    const settings = await rival.get('/v1/admin/sso');
    const claim = settings.body.domains[0];
    const now = await rival.post(`/v1/admin/sso/domains/${claim.id}/verify`);
    expect(now.body).toMatchObject({ status: 'verified' });
    const trail = (await owner.get('/v1/admin/audit/verify')).body;
    expect(trail.ok).toBe(true);
  });
});
