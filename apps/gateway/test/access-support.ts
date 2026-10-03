import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { Client, type Gateway, PASSWORD, signUp } from './harness.js';
import { totpFromUri } from './totp.js';

/** Signs in with password and a TOTP code, as someone with two-step verification does. */
export async function signInWithTotp(gw: Gateway, email: string, uri: string): Promise<Client> {
  const client = new Client(gw.app);
  const first = await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
  expect(first.body.twoFactorRedirect, JSON.stringify(first.body)).toBe(true);
  const second = await client.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  return client;
}

/**
 * Turns on two-step verification for a signed-in person and returns a fresh session that passed
 * it (what MFA-guarded permissions such as security.manage and support.grant need).
 */
export async function enrolTotp(
  gw: Gateway,
  client: Client,
  email: string,
): Promise<{ client: Client; uri: string }> {
  const enabled = await client.post('/api/auth/two-factor/enable', { password: PASSWORD });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  const uri = enabled.body.totpURI as string;
  const verified = await client.post('/api/auth/two-factor/verify-totp', {
    code: totpFromUri(uri),
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const fresh = await signInWithTotp(gw, email, uri);
  fresh.tenant = client.tenant;
  return { client: fresh, uri };
}

/** Makes every session of this person older than the step-up window. */
export async function ageSessions(gw: Gateway, email: string): Promise<void> {
  await gw.owner.execute(
    sql`update auth.session set created_at = now() - interval '1 hour'
        where user_id = (select id from auth.user where email = ${email})`,
  );
}

/** Role ids by key, as the owner sees them. */
export async function roleIds(owner: Client): Promise<Record<string, string>> {
  const list = await owner.get('/v1/admin/roles');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return Object.fromEntries(list.body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
}

/** Invites someone with a role and scope; they sign up, accept and come back signed in. */
export async function join(
  gw: Gateway,
  owner: Client,
  name: string,
  email: string,
  roleId: string,
  scope: object = { type: 'tenant' },
): Promise<{ client: Client; staffId: string }> {
  const invited = await owner.post('/v1/admin/invitations', { email, roleId, scope });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const client = await signUp(gw, name, email);
  const accepted = await client.post('/v1/invitations/accept', { token: invited.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  client.tenant = owner.tenant;
  return { client, staffId: accepted.body.staffMemberId as string };
}

/** A tenant with its owner signed in. */
export async function tenantWithOwner(
  gw: Gateway,
  name: string,
  email: string,
  slug: string,
): Promise<Client> {
  const owner = await signUp(gw, name, email);
  const created = await owner.post('/v1/tenants', { name: `${name}'s workspace`, slug });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  owner.tenant = created.body.tenant.id;
  return owner;
}
