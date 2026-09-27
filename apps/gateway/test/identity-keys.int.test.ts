import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD } from './harness.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';
import { totpFromUri } from './totp.js';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let admin: Client;

const keysPath = () => `/v1/admin/brands/${shop.brand.id}/identity-keys`;

async function assertion(
  key: Parameters<SignJWT['sign']>[0],
  header: { alg: string; kid: string },
  subject = `customer-${randomUUID().slice(0, 8)}`,
) {
  return new SignJWT({ name: 'Fatima Noor', email: 'fatima@example.com', email_verified: true })
    .setProtectedHeader(header)
    .setSubject(subject)
    .setAudience(shop.brand.widgetId)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomUUID())
    .sign(key);
}

async function identify(signed: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  return visitor.call('POST', '/v1/widget/identity', { assertion: signed });
}

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'keys');
});

afterAll(async () => {
  await slice?.close();
});

describe('identity keys', () => {
  it('need two-step verification and a recent sign-in', async () => {
    const denied = await shop.owner.post(keysPath(), { alg: 'HS256' });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('MFA_REQUIRED');

    const enabled = await shop.owner.post('/api/auth/two-factor/enable', { password: PASSWORD });
    const uri = enabled.body.totpURI as string;
    await shop.owner.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
    admin = new Client(slice.gw.app);
    const first = await admin.post('/api/auth/sign-in/email', {
      email: 'keys-owner@example.com',
      password: PASSWORD,
    });
    expect(first.body.twoFactorRedirect).toBe(true);
    const second = await admin.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
    expect(second.status).toBe(200);
    admin.tenant = shop.owner.tenant;
  });

  it('registers a public key that then verifies customers, and refuses private or wrong keys', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const created = await admin.post(keysPath(), { alg: 'ES256', publicJwk, kid: 'shop-2026' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kid: 'shop-2026', alg: 'ES256', status: 'active' });
    expect(created.body.publicJwk).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x,
      y: publicJwk.y,
    });
    expect(created.body.secret).toBeUndefined();

    const identified = await identify(
      await assertion(privateKey, { alg: 'ES256', kid: 'shop-2026' }),
    );
    expect(identified.status, JSON.stringify(identified.body)).toBe(200);
    expect(identified.body.principal).toMatchObject({ verified: true, displayName: 'Fatima Noor' });

    const withPrivate = await admin.post(keysPath(), {
      alg: 'ES256',
      publicJwk: (await exportJWK(privateKey)) as JWK,
    });
    expect(withPrivate.status).toBe(422);
    expect(JSON.stringify(withPrivate.body)).toContain('public key only');
    const ed = await generateKeyPair('EdDSA', { extractable: true });
    const wrongCurve = await admin.post(keysPath(), {
      alg: 'ES256',
      publicJwk: await exportJWK(ed.publicKey),
    });
    expect(wrongCurve.status).toBe(422);
    const duplicate = await admin.post(keysPath(), { alg: 'ES256', publicJwk, kid: 'shop-2026' });
    expect(duplicate.status).toBe(422);
  });

  it('generates an HS256 secret shown once', async () => {
    const created = await admin.post(keysPath(), { alg: 'HS256' });
    expect(created.status).toBe(201);
    expect(created.body.kid).toMatch(/^hk_/);
    expect(created.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed = await admin.get(keysPath());
    const hs = listed.body.items.find((k: { kid: string }) => k.kid === created.body.kid);
    expect(hs).toMatchObject({ alg: 'HS256', status: 'active', publicJwk: null });
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);

    const secret = new TextEncoder().encode(created.body.secret);
    const identified = await identify(
      await assertion(secret, { alg: 'HS256', kid: created.body.kid }),
    );
    expect(identified.status, JSON.stringify(identified.body)).toBe(200);
  });

  it('keeps a retiring key working and refuses a revoked one', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    await admin.post(keysPath(), {
      alg: 'ES256',
      publicJwk: await exportJWK(publicKey),
      kid: 'rotating',
    });
    const retired = await admin.post(`${keysPath()}/rotating/retire`, {});
    expect(retired.body).toMatchObject({ status: 'retiring' });
    expect(retired.body.retiredAt).not.toBeNull();
    expect(
      (await identify(await assertion(privateKey, { alg: 'ES256', kid: 'rotating' }))).status,
    ).toBe(200);

    const revoked = await admin.post(`${keysPath()}/rotating/revoke`, {});
    expect(revoked.body).toMatchObject({ status: 'revoked' });
    const refused = await identify(await assertion(privateKey, { alg: 'ES256', kid: 'rotating' }));
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('ASSERTION_INVALID');
    expect((await admin.post(`${keysPath()}/missing/revoke`, {})).status).toBe(404);

    const tenantId = fromPublicId('tenant', shop.tenantId);
    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, shop.brand.id)),
    );
    const actions = audit.map((a) => a.action);
    expect(actions.filter((a) => a === 'brand.identity_key.created')).toHaveLength(3);
    expect(actions).toContain('brand.identity_key.retired');
    expect(actions).toContain('brand.identity_key.revoked');
  });
});
