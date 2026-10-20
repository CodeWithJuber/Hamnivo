import { DEFAULT_EMAIL_BRANDING, DEFAULT_PORTAL_BRANDING } from '@hamnivo/contracts';
import { fromPublicId } from '@hamnivo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendBrandedCustomerMail } from '../src/branding/customer-email.js';
import { APP_DB } from '../src/tokens.js';
import { Client, type Gateway, PASSWORD, signUp, startGateway } from './harness.js';

const txt = new Map<string, string[][]>();
let gw: Gateway;
let owner: Client;
let rival: Client;
let domain: any;
let rivalDomain: any;
const hostname = 'portal.acme.example';
beforeAll(async () => {
  gw = await startGateway({ PORTAL_CUSTOM_HOSTS: hostname }, undefined, {
    dns: {
      async resolveTxt(name) {
        const found = txt.get(name);
        if (found) return found;
        throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' });
      },
    },
  });
  owner = await signUp(gw, 'Portal Owner', 'portal-owner@example.com');
  const tenant = await owner.post('/v1/tenants', { name: 'Portal Owner', slug: 'portal-owner' });
  owner.tenant = tenant.body.tenant.id;
  rival = await signUp(gw, 'Rival', 'portal-rival@example.com');
  const other = await rival.post('/v1/tenants', { name: 'Rival', slug: 'portal-rival' });
  rival.tenant = other.body.tenant.id;
});
afterAll(async () => {
  await gw?.close();
});

describe('persisted branding and DNS isolation', () => {
  it('persists tenant settings without exposing email branding publicly', async () => {
    const defaults = await owner.get('/v1/admin/branding');
    expect(defaults.status).toBe(200);
    expect(defaults.body.portal.displayName).toBe('Hamnivo');
    const saved = await owner.put('/v1/admin/branding', {
      portal: { ...DEFAULT_PORTAL_BRANDING, displayName: 'Acme Desk', showBranding: false },
      email: {
        ...DEFAULT_EMAIL_BRANDING,
        replyTo: 'help@acme.example',
        senderName: 'Acme Support',
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await owner.get('/v1/admin/branding')).body.portal.displayName).toBe('Acme Desk');
    expect((await rival.get('/v1/admin/branding')).body.portal.displayName).toBe('Hamnivo');
    await sendBrandedCustomerMail(
      gw.app.get(APP_DB),
      gw.mailer,
      fromPublicId('tenant', owner.tenant!),
      'Fallback',
      {
        to: 'customer@example.com',
        subject: 'Reply',
        text: '<customer message>',
        template: 'customer.reply_waiting',
      },
    );
    expect(gw.mailer.last('customer@example.com')).toMatchObject({
      senderName: 'Acme Support',
      replyTo: 'help@acme.example',
    });
    expect(gw.mailer.last('customer@example.com')?.html).toContain('&lt;customer message&gt;');
    const created = await owner.post('/v1/admin/branding/domains', { hostname });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    domain = created.body;
    expect(domain.status).toBe('pending');
    expect((await owner.get('/v1/branding', { headers: { host: hostname } })).status).toBe(404);
    const competing = await rival.post('/v1/admin/branding/domains', { hostname });
    expect(competing.status).toBe(201);
    rivalDomain = competing.body;
    expect((await rival.post(`/v1/admin/branding/domains/${domain.id}/verify`)).status).toBe(404);
    expect((await rival.post(`/v1/admin/branding/domains/${domain.id}/disable`)).status).toBe(404);
  });
  it('requires DNS even for operator-configured hosts, and returns a safe public view', async () => {
    expect((await owner.post(`/v1/admin/branding/domains/${domain.id}/verify`)).body.status).toBe(
      'pending',
    );
    txt.set(domain.verification.name, [
      [domain.verification.value.slice(0, 12), domain.verification.value.slice(12)],
    ]);
    const verified = await owner.post(`/v1/admin/branding/domains/${domain.id}/verify`);
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('active');
    expect(
      (await rival.post(`/v1/admin/branding/domains/${rivalDomain.id}/verify`)).body.status,
    ).toBe('pending');
    txt.set(domain.verification.name, [
      [domain.verification.value],
      [rivalDomain.verification.value],
    ]);
    expect((await rival.post(`/v1/admin/branding/domains/${rivalDomain.id}/verify`)).status).toBe(
      422,
    );
    const resolved = await owner.get('/v1/branding', { headers: { host: hostname } });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      portal: { ...DEFAULT_PORTAL_BRANDING, displayName: 'Acme Desk', showBranding: false },
      customDomain: true,
    });
    expect(
      (
        await owner.get('/v1/branding', {
          headers: { host: 'unclaimed.example', 'x-forwarded-host': hostname },
        })
      ).status,
    ).toBe(404);
    const pending = await owner.post('/v1/admin/branding/domains', {
      hostname: 'not-routed.acme.example',
    });
    txt.set(pending.body.verification.name, [[pending.body.verification.value]]);
    const proved = await owner.post(`/v1/admin/branding/domains/${pending.body.id}/verify`);
    expect(proved.body).toMatchObject({ status: 'verified', routingReady: false, tlsReady: false });
  });
  it('supports same-origin custom login with host-only cookies and rejects arbitrary callbacks', async () => {
    const login = await gw.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: hostname, origin: `https://${hostname}` },
      payload: { email: 'portal-owner@example.com', password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toMatch(/domain=/i);
    const rawCookies = login.headers['set-cookie'];
    const sessionCookie = (Array.isArray(rawCookies) ? rawCookies : [String(rawCookies)])
      .map((value) => value.split(';')[0])
      .join('; ');
    const me = await gw.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        host: hostname,
        origin: `https://${hostname}`,
        cookie: sessionCookie,
        'x-hamnivo-tenant': owner.tenant!,
      },
    });
    expect(me.statusCode, me.body).toBe(200);
    const otherTenant = await gw.app.inject({
      method: 'GET',
      url: '/v1/admin/branding',
      headers: {
        host: hostname,
        origin: `https://${hostname}`,
        cookie: sessionCookie,
        'x-hamnivo-tenant': rival.tenant!,
      },
    });
    expect(otherTenant.statusCode).toBe(404);
    const denied = await gw.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: hostname, origin: 'https://attacker.example' },
      payload: { email: 'portal-owner@example.com', password: PASSWORD },
    });
    expect(denied.statusCode).toBe(403);
    const redirect = await gw.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: hostname, origin: `https://${hostname}` },
      payload: {
        email: 'portal-owner@example.com',
        password: PASSWORD,
        callbackURL: 'https://attacker.example',
      },
    });
    expect(redirect.statusCode).toBe(403);
    const passkey = await gw.app.inject({
      method: 'GET',
      url: '/api/auth/passkey/generate-authenticate-options',
      headers: { host: hostname, origin: `https://${hostname}` },
    });
    expect(passkey.statusCode).toBe(403);
  });
  it('revokes DNS trust on a missing challenge and rotates proof on disable', async () => {
    txt.delete(domain.verification.name);
    expect((await owner.post(`/v1/admin/branding/domains/${domain.id}/verify`)).body.status).toBe(
      'pending',
    );
    expect((await owner.get('/v1/branding', { headers: { host: hostname } })).status).toBe(404);
    txt.set(domain.verification.name, [[domain.verification.value]]);
    await owner.post(`/v1/admin/branding/domains/${domain.id}/verify`);
    const disabled = await owner.post(`/v1/admin/branding/domains/${domain.id}/disable`);
    expect(disabled.body.status).toBe('disabled');
    expect(disabled.body.verification.value).not.toBe(domain.verification.value);
    expect((await owner.get('/v1/branding', { headers: { host: hostname } })).status).toBe(404);
    expect((await owner.post(`/v1/admin/branding/domains/${domain.id}/verify`)).body.status).toBe(
      'disabled',
    );
    const login = await gw.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: hostname, origin: `https://${hostname}` },
      payload: { email: 'portal-owner@example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(404);
  });
});
