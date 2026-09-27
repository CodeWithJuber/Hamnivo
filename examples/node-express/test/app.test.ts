import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  type GeneratedIdentityKey,
  generateIdentityKey,
  HamnivoIdentityError,
  type IdentitySigningKey,
} from '@hamnivo/server';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
/** The gateway's verification options (apps/gateway/src/widget/sessions.service.ts). */
const GATEWAY = {
  audience: WIDGET,
  maxTokenAge: '5m',
  requiredClaims: ['sub', 'exp', 'iat', 'jti'],
};
const secret = randomBytes(32).toString('base64url');

interface Site {
  url(path: string): string;
  close(): Promise<void>;
}

/** Everything the tests received, to check that no response ever carried key material. */
const received: string[] = [];
const assertions: string[] = [];
const sites: Site[] = [];

async function start(key: IdentitySigningKey): Promise<Site> {
  const server = createApp({
    widgetId: WIDGET,
    widgetOrigin: 'https://chat.example.com',
    api: 'https://api.example.com',
    key,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const site = {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  sites.push(site);
  return site;
}

async function call(site: Site, path: string, init: RequestInit = {}) {
  const response = await fetch(site.url(path), { redirect: 'manual', ...init });
  const body = await response.text();
  received.push(JSON.stringify([...response.headers]), body);
  return { status: response.status, headers: response.headers, body };
}

async function signIn(site: Site, userId = 'user_1001'): Promise<string> {
  const response = await call(site, '/sign-in', {
    method: 'POST',
    body: new URLSearchParams({ userId }),
  });
  expect(response.status).toBe(303);
  const cookie = response.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
  return cookie.split(';')[0] as string;
}

async function identity(site: Site, cookie?: string, path = '/hamnivo/identity') {
  const response = await call(site, path, cookie ? { headers: { cookie } } : {});
  if (response.status === 200) assertions.push(JSON.parse(response.body).assertion);
  return response;
}

let es256: GeneratedIdentityKey;
let es256Site: Site;
let hs256Site: Site;

beforeAll(async () => {
  es256 = await generateIdentityKey('ES256');
  es256Site = await start({ kid: es256.kid, alg: 'ES256', privateKey: es256.privateJwk });
  hs256Site = await start({ kid: 'hk_example', alg: 'HS256', secret });
});

afterAll(async () => {
  await Promise.all(sites.map((site) => site.close()));
});

describe('GET /hamnivo/identity', () => {
  it('refuses signed-out visitors', async () => {
    const response = await identity(es256Site);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a sign-in cookie that the browser made up or changed', async () => {
    const real = await signIn(es256Site);
    const signature = real.slice(real.lastIndexOf('.') + 1);
    const forged = [
      'example_session=user_1001',
      `example_session=user_1002.${signature}`,
      `${real}x`,
      'example_session=.x',
    ];
    for (const cookie of forged) expect((await identity(es256Site, cookie)).status).toBe(401);
    // Another server signs cookies with another secret.
    expect((await identity(hs256Site, real)).status).toBe(401);
  });

  it('returns an assertion that verifies with the matching public key', async () => {
    const response = await identity(es256Site, await signIn(es256Site));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { assertion } = JSON.parse(response.body);
    const verified = await jwtVerify(assertion, await importJWK(es256.publicJwk, 'ES256'), {
      algorithms: ['ES256'],
      ...GATEWAY,
    });
    expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', kid: es256.kid });
    expect(verified.payload).toMatchObject({
      sub: 'user_1001',
      aud: WIDGET,
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      email_verified: true,
    });
  });

  it('signs HS256 assertions with the secret Hamnivo showed', async () => {
    const response = await identity(hs256Site, await signIn(hs256Site, 'user_1002'));
    const { assertion } = JSON.parse(response.body);
    const { payload } = await jwtVerify(assertion, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      ...GATEWAY,
    });
    expect(payload).toMatchObject({
      sub: 'user_1002',
      email: 'omar@example.com',
      email_verified: false,
    });
  });

  it('signs what the server knows, not what the browser sends', async () => {
    const cookie = await signIn(es256Site);
    const response = await call(
      es256Site,
      '/hamnivo/identity?sub=user_1002&email=mallory@example.com',
      { headers: { cookie, 'x-user-id': 'user_1002' } },
    );
    assertions.push(JSON.parse(response.body).assertion);
    expect(decodeJwt(JSON.parse(response.body).assertion)).toMatchObject({
      sub: 'user_1001',
      email: 'ayesha@example.com',
    });
  });

  it('gives every call a fresh assertion', async () => {
    const cookie = await signIn(es256Site);
    const jtis = [];
    for (let i = 0; i < 3; i++) {
      jtis.push(decodeJwt(JSON.parse((await identity(es256Site, cookie)).body).assertion).jti);
    }
    expect(new Set(jtis).size).toBe(3);
  });

  it('gives the browser no details when the key is wrong', async () => {
    const eddsa = await generateIdentityKey('EdDSA');
    const broken = await start({ kid: 'k1', alg: 'ES256', privateKey: eddsa.privateJwk });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await identity(broken, await signIn(broken));
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: 'Something went wrong.' });
      expect(logged).toHaveBeenCalledWith(expect.any(HamnivoIdentityError));
      expect(response.body).not.toContain(eddsa.privateJwk.d);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('pages', () => {
  it('serve the loader and the script that identifies and resets', async () => {
    const signedOut = await call(es256Site, '/');
    expect(signedOut.body).toContain('data-signed-in="false"');
    expect(signedOut.body).toContain(
      `<script src="https://chat.example.com/loader.js" data-widget-id="${WIDGET}"`,
    );
    expect(signedOut.body).toContain('data-api="https://api.example.com" async></script>');
    expect(signedOut.body).toContain('<script type="module" src="/identity.js"></script>');

    const signedIn = await call(es256Site, '/', { headers: { cookie: await signIn(es256Site) } });
    expect(signedIn.body).toContain('data-signed-in="true"');
    expect(signedIn.body).toContain('Signed in as Ayesha Khan.');
    expect(signedIn.body).toContain('<form id="sign-out" method="post" action="/sign-out">');

    const script = await call(es256Site, '/identity.js');
    expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect(script.body).toContain("fetch('/hamnivo/identity'");
    expect(script.body).toContain('hamnivo.identify(assertion)');
    expect(script.body).toContain('window.Hamnivo?.reset()');
  });

  it('sign the customer out by clearing the cookie', async () => {
    const response = await call(es256Site, '/sign-out', { method: 'POST' });
    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toMatch(
      /^example_session=;.*Expires=Thu, 01 Jan 1970/,
    );
  });

  it('refuse to sign in an unknown user', async () => {
    const response = await call(es256Site, '/sign-in', {
      method: 'POST',
      body: new URLSearchParams({ userId: 'user_9999' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('the identity key', () => {
  it('never leaves the server', async () => {
    await call(es256Site, '/missing');
    const material = [es256.privateJwk.d as string, JSON.stringify(es256.privateJwk), secret];
    expect(received.length).toBeGreaterThan(30);
    for (const text of received) {
      for (const value of material) expect(text).not.toContain(value);
    }
    expect(assertions.length).toBeGreaterThan(5);
    for (const assertion of assertions) {
      const decoded = JSON.stringify([decodeProtectedHeader(assertion), decodeJwt(assertion)]);
      expect(decoded).not.toContain(es256.privateJwk.d);
      expect(decoded).not.toContain(secret);
      expect(Object.keys(decodeProtectedHeader(assertion)).sort()).toEqual(['alg', 'kid', 'typ']);
    }
  });
});
