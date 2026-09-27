/**
 * End-to-end stack for the widget journey (run by Playwright's webServer):
 *   throwaway database · fake Chatwoot · gateway API and worker (built, as separate processes)
 *   · widget static site + loader · a host page on another origin.
 * It seeds a tenant, a brand allowed on the host page and a Chatwoot connection, then writes
 * e2e/.stack.json for the tests. Stops everything on SIGTERM/SIGINT.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
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
    body: JSON.stringify({
      name: 'Sara Staff',
      email: 'sara@example.com',
      password: 'correct horse battery staple',
    }),
  });
  const cookie = (signUp.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
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
        databaseUrl: database.app,
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
