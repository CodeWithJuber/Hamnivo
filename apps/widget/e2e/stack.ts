/**
 * End-to-end stack for the widget journey (run by Playwright's webServer):
 *   throwaway database · fake Chatwoot · gateway API and worker (built, as separate processes)
 *   · widget static site + loader · a host page on another origin.
 * It seeds a tenant, a brand allowed on the host page and a Chatwoot connection, then writes
 * e2e/.stack.json for the tests. Stops everything on SIGTERM/SIGINT.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { startFakeStripe } from '@hamnivo/adapters/commerce/testing';
import { startFakeChatwoot } from '@hamnivo/chatwoot/fake';
import {
  createTestDatabase,
  dropDatabase,
  loadLocalEnv,
  prepareTemplateDatabase,
} from '@hamnivo/db/testing';

const root = resolve(import.meta.dirname, '../../..');
const ports = {
  host: Number(process.env.E2E_HOST_PORT ?? 5180),
  api: Number(process.env.E2E_API_PORT ?? 5181),
  widget: Number(process.env.E2E_WIDGET_PORT ?? 5182),
  console: Number(process.env.E2E_CONSOLE_PORT ?? 5183),
};
const origin = (port: number) => `http://127.0.0.1:${port}`;
const PASSWORD = 'correct horse battery staple';

/** The code an authenticator app shows for a base32 TOTP secret (RFC 6238: SHA-1, 6 digits). */
function totp(secret: string, at = Date.now()): string {
  let bits = 0;
  let value = 0;
  const key: number[] = [];
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** "name=value; …" for the cookies a response sets. */
const cookiesOf = (response: Response) =>
  (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const children: ChildProcess[] = [];
const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

function staticServer(port: number, dirs: string[], fallback?: string): Promise<void> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/health') {
      response.end('ok');
      return;
    }
    for (const dir of dirs) {
      const file = normalize(join(dir, url.pathname === '/' ? 'index.html' : url.pathname));
      if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) {
        response.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(response);
        return;
      }
    }
    if (fallback) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      createReadStream(fallback).pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok()));
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  for (const server of servers) server.close();
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  loadLocalEnv();
  const template = `hamnivo_tpl_e2e_${process.pid}`;
  await prepareTemplateDatabase(template);
  cleanups.push(() => dropDatabase(template));
  const database = await createTestDatabase(template);
  cleanups.push(() => database.drop());

  const fake = await startFakeChatwoot();
  cleanups.push(() => fake.close());
  // A stateful fake of Stripe's API and hosted payment page: nothing reaches the real Stripe.
  const stripe = await startFakeStripe();
  cleanups.push(() => stripe.close());

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(ports.api),
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    DATABASE_URL: database.app,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    HAMNIVO_KEK_BASE64: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    PUBLIC_API_ORIGIN: origin(ports.api),
    PUBLIC_CONSOLE_ORIGIN: origin(ports.console),
    PUBLIC_WIDGET_ORIGIN: origin(ports.widget),
    REQUIRE_EMAIL_VERIFICATION: 'false',
    CHATWOOT_URL: fake.url,
    CHATWOOT_PLATFORM_TOKEN: fake.platformToken,
    CHATWOOT_WEBHOOK_BASE_URL: origin(ports.api),
    STREAM_HEARTBEAT_SECONDS: '5',
    RATE_LIMIT_PER_MINUTE: '100000',
    COMMERCE_STRIPE_API_BASE: stripe.url,
  };
  delete env.WIDGET_SIGNING_KEY;
  const gatewayDist = join(root, 'apps/gateway/dist');
  for (const entry of ['main.api.js', 'main.worker.js']) {
    const child = spawn(process.execPath, ['--enable-source-maps', join(gatewayDist, entry)], {
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code && code !== 143) void shutdown(1);
    });
    children.push(child);
  }
  await waitFor(`${origin(ports.api)}/health/ready`);

  // Seed: owner → tenant → brand allowed on the host page → Chatwoot connection.
  const consoleHeaders = { origin: origin(ports.console), 'content-type': 'application/json' };
  const signUp = await fetch(`${origin(ports.api)}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: consoleHeaders,
    body: JSON.stringify({ name: 'Sara Staff', email: 'sara@example.com', password: PASSWORD }),
  });
  let cookie = cookiesOf(signUp);
  if (!signUp.ok || !cookie) throw new Error(`sign-up failed: ${signUp.status}`);
  const call = async (method: string, path: string, body?: unknown, tenant?: string) => {
    const response = await fetch(`${origin(ports.api)}${path}`, {
      method,
      headers: { ...consoleHeaders, cookie, ...(tenant ? { 'x-hamnivo-tenant': tenant } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const tenant = await call('POST', '/v1/tenants', { name: 'Noor Books', slug: 'noor-books' });
  const tenantId = tenant.tenant.id as string;
  const workspaces = await call('GET', '/v1/admin/workspaces', undefined, tenantId);
  const brand = await call(
    'POST',
    '/v1/admin/brands',
    {
      workspaceId: workspaces.items[0].id,
      name: 'Noor Books',
      allowedOrigins: [origin(ports.host)],
    },
    tenantId,
  );
  await call('POST', '/v1/admin/authority/connections', { brandId: brand.id }, tenantId);
  // Connecting creates the brand's assistant as a draft; publishing it lets the AI answer.
  const agents = await call('GET', '/v1/admin/agents', undefined, tenantId);
  const agent = agents.items.find((a: { brandId: string }) => a.brandId === brand.id);
  await call('POST', `/v1/admin/agents/${agent.id}/publish`, {}, tenantId);

  // A key that vouches for signed-in customers (W12). Registering one needs two-step verification
  // and a sign-in with a code, as an owner would do it.
  const enabled = await call('POST', '/api/auth/two-factor/enable', { password: PASSWORD });
  const totpSecret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
  await call('POST', '/api/auth/two-factor/verify-totp', { code: totp(totpSecret) });
  const firstFactor = await fetch(`${origin(ports.api)}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: consoleHeaders,
    body: JSON.stringify({ email: 'sara@example.com', password: PASSWORD }),
  });
  const secondFactor = await fetch(`${origin(ports.api)}/api/auth/two-factor/verify-totp`, {
    method: 'POST',
    headers: { ...consoleHeaders, cookie: cookiesOf(firstFactor) },
    body: JSON.stringify({ code: totp(totpSecret) }),
  });
  cookie = cookiesOf(secondFactor);
  if (!secondFactor.ok || !cookie)
    throw new Error(`two-step sign-in failed: ${secondFactor.status}`);
  const identityKey = await call(
    'POST',
    `/v1/admin/brands/${brand.id}/identity-keys`,
    { alg: 'HS256' },
    tenantId,
  );
  // The brand sells in chat through Stripe (the fake): prices in AED, delivery AED 10.00.
  const webhookSecret = `whsec_e2e_${randomBytes(12).toString('hex')}`;
  const merchant = await call(
    'POST',
    '/v1/admin/commerce/merchants',
    {
      brandId: brand.id,
      provider: 'stripe',
      displayName: 'Noor Books',
      currencies: ['AED'],
      apiKey: stripe.apiKey,
      webhookSecret,
      shipping: { amountMinor: '1000', label: 'Delivery' },
      quoteMinutes: 5,
      terms: { refundSummary: 'Refunds within 14 days of delivery.' },
    },
    tenantId,
  );
  stripe.webhookEndpoints.push({ url: merchant.webhookUrl, secret: webhookSecret });

  const hostPage = join(root, 'apps/widget/e2e/.host.html');
  writeFileSync(
    hostPage,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Noor Books</title></head>
<body><main><h1>Noor Books</h1><p>Welcome to our store.</p></main>
<script src="${origin(ports.widget)}/loader.js" data-widget-id="${brand.widgetId}" data-api="${origin(ports.api)}" async></script>
</body></html>`,
  );
  await staticServer(ports.widget, [
    join(root, 'apps/widget/dist'),
    join(root, 'packages/widget-loader/dist'),
  ]);
  await staticServer(ports.host, [], hostPage);
  writeFileSync(
    join(root, 'apps/widget/e2e/.stack.json'),
    JSON.stringify(
      {
        hostUrl: origin(ports.host),
        apiBase: origin(ports.api),
        widgetOrigin: origin(ports.widget),
        consoleOrigin: origin(ports.console),
        widgetId: brand.widgetId,
        tenantId,
        cookie,
        identityKey: { kid: identityKey.kid, secret: identityKey.secret },
        databaseUrl: database.app,
        stripeUrl: stripe.url,
      },
      null,
      2,
    ),
  );
  console.log(`[e2e] stack ready: host ${origin(ports.host)}, api ${origin(ports.api)}`);
} catch (error) {
  console.error('[e2e] stack failed:', error);
  await shutdown(1);
}
