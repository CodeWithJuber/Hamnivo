import { randomBytes } from 'node:crypto';
import { closeDb, createDb, fromPublicId, withTenant } from '@hamnivo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryMailer } from '../src/platform/mailer.js';
import { SecretBroker } from '../src/secrets/secret-broker.service.js';
import { Client, type Gateway, PASSWORD, signUp, startGateway, testEnv } from './harness.js';
import { totpFromUri } from './totp.js';

let gw: Gateway;
let owner: Client;
const kekV1 = randomBytes(32).toString('base64');

beforeAll(async () => {
  gw = await startGateway({ HAMNIVO_KEK_BASE64: kekV1, HAMNIVO_KEK_VERSION: '1' });
  owner = await signUp(gw, 'Sana Owner', 'sana@example.com');
  owner.tenant = (await owner.post('/v1/tenants', { name: 'Acme', slug: 'acme' })).body.tenant.id;
});

afterAll(async () => {
  await gw?.close();
});

describe('credentials need two-step verification', () => {
  it('refuses secret management until TOTP is enabled, then works', async () => {
    const denied = await owner.post('/v1/admin/secrets', {
      kind: 'chatwoot.token',
      label: 'Chatwoot',
      value: 'x'.repeat(24),
    });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('MFA_REQUIRED');

    const enabled = await owner.post('/api/auth/two-factor/enable', { password: PASSWORD });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const uri = enabled.body.totpURI as string;
    expect(enabled.body.backupCodes.length).toBeGreaterThan(0);
    const verified = await owner.post('/api/auth/two-factor/verify-totp', {
      code: totpFromUri(uri),
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect((await owner.get('/v1/me')).body.user.twoFactorEnabled).toBe(true);

    // Signing in again now needs the second factor.
    const fresh = new Client(gw.app);
    const first = await fresh.post('/api/auth/sign-in/email', {
      email: 'sana@example.com',
      password: PASSWORD,
    });
    expect(first.body.twoFactorRedirect).toBe(true);
    expect((await fresh.get('/v1/me')).status).toBe(401);
    const second = await fresh.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
    expect(second.status).toBe(200);
    fresh.tenant = owner.tenant;
    owner = fresh;
    expect((await owner.get('/v1/me')).body.current.mfa).toBe(true);
  });

  it('stores values write-only, masked, rotatable and revocable', async () => {
    const created = await owner.post(
      '/v1/admin/secrets',
      { kind: 'chatwoot.token', label: 'Chatwoot bot', value: 'cw-token-0123456789abcdef' },
      { headers: { 'idempotency-key': 'secret-1' } },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'chatwoot.token',
      label: 'Chatwoot bot',
      masked: '••••cdef',
    });
    expect(JSON.stringify(created.body)).not.toContain('cw-token');
    const replay = await owner.post(
      '/v1/admin/secrets',
      { kind: 'chatwoot.token', label: 'Chatwoot bot', value: 'cw-token-0123456789abcdef' },
      { headers: { 'idempotency-key': 'secret-1' } },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(created.body.id);

    const broker = gw.app.get(SecretBroker);
    const tenantId = fromPublicId('tenant', owner.tenant as string);
    const secretId = fromPublicId('secret', created.body.id);
    const app = createDb(gw.database.app, { max: 1 });
    try {
      expect(
        await withTenant(app, { tenantId }, (tx) => broker.reveal(tx, tenantId, secretId)),
      ).toBe('cw-token-0123456789abcdef');
      const rotated = await owner.post(`/v1/admin/secrets/${created.body.id}/rotate`, {
        value: 'cw-token-rotated-9999',
      });
      expect(rotated.body).toMatchObject({ masked: '••••9999' });
      expect(rotated.body.rotatedAt).not.toBeNull();
      expect(
        await withTenant(app, { tenantId }, (tx) => broker.reveal(tx, tenantId, secretId)),
      ).toBe('cw-token-rotated-9999');

      // Another tenant cannot reveal it, even with the right ID.
      const other = await signUp(gw, 'Other Owner', 'other@example.com');
      const otherTenant = fromPublicId(
        'tenant',
        (await other.post('/v1/tenants', { name: 'Other', slug: 'other' })).body.tenant.id,
      );
      await expect(
        withTenant(app, { tenantId: otherTenant }, (tx) =>
          broker.reveal(tx, otherTenant, secretId),
        ),
      ).rejects.toThrow();

      expect((await owner.delete(`/v1/admin/secrets/${created.body.id}`)).status).toBe(204);
      await expect(
        withTenant(app, { tenantId }, (tx) => broker.reveal(tx, tenantId, secretId)),
      ).rejects.toThrow();
    } finally {
      await closeDb(app);
    }
    const audit = await owner.get('/v1/admin/audit?limit=50');
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['secret.created', 'secret.rotated', 'secret.revoked']),
    );
    expect(JSON.stringify(audit.body)).not.toContain('cw-token');
  });

  it('keeps secrets readable across a key-encryption-key rotation and rewraps them', async () => {
    const created = await owner.post('/v1/admin/secrets', {
      kind: 'smtp.password',
      label: 'SMTP',
      value: 'smtp-password-42',
    });
    const tenantId = fromPublicId('tenant', owner.tenant as string);
    const secretId = fromPublicId('secret', created.body.id);

    const kekV2 = randomBytes(32).toString('base64');
    const rotatedConfig = loadConfig(
      testEnv(gw.database, {
        HAMNIVO_KEK_BASE64: kekV2,
        HAMNIVO_KEK_VERSION: '2',
        HAMNIVO_KEK_RETIRED: `1:${kekV1}`,
        BETTER_AUTH_SECRET: gw.config.BETTER_AUTH_SECRET,
      }),
    );
    const rotatedApp = await createApiApp(rotatedConfig, { mailer: new MemoryMailer() });
    const db = createDb(gw.database.app, { max: 1 });
    try {
      const broker = rotatedApp.get(SecretBroker);
      expect(
        await withTenant(db, { tenantId }, (tx) => broker.reveal(tx, tenantId, secretId)),
      ).toBe('smtp-password-42');
    } finally {
      await rotatedApp.close();
    }

    // With only the new key available, the rewrapped secret still opens.
    const onlyV2 = await createApiApp(
      loadConfig(
        testEnv(gw.database, {
          HAMNIVO_KEK_BASE64: kekV2,
          HAMNIVO_KEK_VERSION: '2',
          BETTER_AUTH_SECRET: gw.config.BETTER_AUTH_SECRET,
        }),
      ),
      { mailer: new MemoryMailer() },
    );
    try {
      const broker = onlyV2.get(SecretBroker);
      expect(
        await withTenant(db, { tenantId }, (tx) => broker.reveal(tx, tenantId, secretId)),
      ).toBe('smtp-password-42');
    } finally {
      await onlyV2.close();
      await closeDb(db);
    }
  });
});
