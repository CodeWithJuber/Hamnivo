/**
 * End-to-end stack for the Studio journey (run by Playwright's webServer):
 *   throwaway database · fake Chatwoot · gateway API and worker (built, as separate processes)
 *   · widget and loader (what the install snippet points to) · Studio's static build
 *   · an OpenID Connect provider and a DNS server for single sign-on.
 *   · a webhook receiver (a trusted egress origin, so deliveries may reach it over local HTTP).
 *   · a control port for the fake Chatwoot's test hooks (a customer writing on WhatsApp…).
 * Studio is served with the gateway behind its own origin: /v1 and /api/auth are passed on to the
 * gateway, the same-origin set-up the README describes, so the gateway's public origin is Studio's.
 * Studio is served as http://localhost (passkeys need a host name, never an IP address). Nothing
 * is seeded; the tests sign up in the browser. Writes e2e/.stack.json for the tests and stops
 * everything on SIGTERM/SIGINT.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { startFakeStripe } from '@hamnivo/adapters/commerce/testing';
import { type FakeChatwoot, startFakeChatwoot } from '@hamnivo/chatwoot/fake';
import {
  createTestDatabase,
  dropDatabase,
  loadLocalEnv,
  prepareTemplateDatabase,
} from '@hamnivo/db/testing';
import { startDnsServer } from './dns.ts';
import { startE2eIdp } from './idp.ts';

const root = resolve(import.meta.dirname, '../../..');
const ports = {
  api: Number(process.env.E2E_STUDIO_API_PORT ?? 5185),
  studio: Number(process.env.E2E_STUDIO_PORT ?? 5186),
  widget: Number(process.env.E2E_STUDIO_WIDGET_PORT ?? 5187),
  idp: Number(process.env.E2E_STUDIO_IDP_PORT ?? 5188),
  dns: Number(process.env.E2E_STUDIO_DNS_PORT ?? 5189),
  hooks: Number(process.env.E2E_STUDIO_HOOKS_PORT ?? 5190),
  fake: Number(process.env.E2E_STUDIO_FAKE_PORT ?? 5191),
};
const origin = (port: number) => `http://127.0.0.1:${port}`;
const studioOrigin = `http://localhost:${ports.studio}`;
const dnsRecords = join(root, 'apps/console/e2e/.dns.json');
const children: ChildProcess[] = [];
const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendFile(response: ServerResponse, file: string) {
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}

function findFile(dirs: string[], pathname: string): string | null {
  for (const dir of dirs) {
    const file = normalize(join(dir, pathname === '/' ? 'index.html' : pathname));
    if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** Passes a request on to the gateway unchanged, as a reverse proxy in front of Studio would. */
function proxy(request: IncomingMessage, response: ServerResponse) {
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: ports.api,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${ports.api}` },
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

function listen(server: Server, port: number): Promise<void> {
  servers.push(server);
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok()));
}

function widgetServer(): Promise<void> {
  const dirs = [join(root, 'apps/widget/dist'), join(root, 'packages/widget-loader/dist')];
  return listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const file = findFile(dirs, url.pathname);
      if (file) sendFile(response, file);
      else response.writeHead(404).end();
    }),
    ports.widget,
  );
}

function studioServer(): Promise<void> {
  const dist = join(root, 'apps/console/dist');
  // Runtime settings (see src/lib/config.ts): same-origin API, and the snippet's origins.
  const settings = [
    '<meta name="hamnivo-api" content="">',
    `<meta name="hamnivo-gateway-origin" content="${origin(ports.api)}">`,
    `<meta name="hamnivo-widget-origin" content="${origin(ports.widget)}">`,
  ].join('');
  // Read on every request, so a rebuild while the stack runs is served at once.
  const index = () =>
    readFileSync(join(dist, 'index.html'), 'utf8').replace('</head>', `${settings}</head>`);
  return listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      if (url.pathname === '/health') {
        response.end('ok');
        return;
      }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/auth/')) {
        proxy(request, response);
        return;
      }
      const file = url.pathname === '/' ? null : findFile([dist], url.pathname);
      if (file) {
        sendFile(response, file);
        return;
      }
      // Single-page app: every other path renders index.html.
      response.writeHead(200, { 'content-type': TYPES['.html'] ?? 'text/html' });
      response.end(index());
    }),
    ports.studio,
  );
}

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

/**
 * Receives webhook deliveries: records each request and answers with the status set for its path
 * (204 unless told otherwise). Tests read `GET /__received?path=…` and set
 * `POST /__status {"path", "status"}`.
 */
function hooksServer(): Promise<void> {
  const received: Received[] = [];
  const statuses = new Map<string, number>();
  return listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname === '/__received') {
          const path = url.searchParams.get('path');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(received.filter((r) => !path || r.path === path)));
          return;
        }
        if (url.pathname === '/__status' && request.method === 'POST') {
          const set = JSON.parse(body) as { path: string; status: number };
          statuses.set(set.path, set.status);
          response.writeHead(204).end();
          return;
        }
        received.push({
          path: url.pathname,
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(', ') : (value ?? ''),
            ]),
          ),
          body,
          at: Date.now(),
        });
        const status = statuses.get(url.pathname) ?? 204;
        if (status === 204) {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end(status >= 400 ? 'receiver unavailable' : 'ok');
      });
    }),
    ports.hooks,
  );
}

/**
 * The fake Chatwoot's test hooks, which only exist in this process, for the tests to call over
 * HTTP: `POST /receive-channel-message {inboxId, from, name?, content, hoursAgo?}` (a customer
 * writes on email, WhatsApp or Telegram, now or `hoursAgo` hours ago; answers once the webhooks are
 * delivered) and `POST /whatsapp-templates {inboxId, templates, syncedAt?}`.
 */
function fakeControlServer(fake: FakeChatwoot): Promise<void> {
  const hooks: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    '/receive-channel-message': async ({ inboxId, from, name, content, hoursAgo }) => {
      const made = await fake.receiveChannelMessage(Number(inboxId), {
        from: String(from),
        content: String(content),
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof hoursAgo === 'number' ? { hoursAgo } : {}),
      });
      await fake.flush();
      return made;
    },
    '/whatsapp-templates': async ({ inboxId, templates, syncedAt }) =>
      fake.setWhatsappTemplates(
        Number(inboxId),
        templates as Parameters<FakeChatwoot['setWhatsappTemplates']>[1],
        typeof syncedAt === 'string' ? new Date(syncedAt) : syncedAt === null ? null : undefined,
      ),
  };
  return listen(
    createServer((request, response) => {
      const hook = hooks[new URL(request.url ?? '/', 'http://x').pathname];
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (!hook || request.method !== 'POST') {
          response.writeHead(404).end();
          return;
        }
        hook(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          .then((result) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result ?? {}));
          })
          .catch((error: Error) => {
            response.writeHead(400, { 'content-type': 'text/plain' });
            response.end(error.message);
          });
      });
    }),
    ports.fake,
  );
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
  // No default: a missing setting must not fall through to someone's everyday Valkey.
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Set REDIS_URL (and DATABASE_URL, DATABASE_OWNER_URL).');
  const template = `hamnivo_tpl_studio_${process.pid}`;
  await prepareTemplateDatabase(template);
  cleanups.push(() => dropDatabase(template));
  const database = await createTestDatabase(template);
  cleanups.push(() => database.drop());

  const fake = await startFakeChatwoot();
  cleanups.push(() => fake.close());
  // A stateful fake of Stripe's API and hosted payment page: nothing reaches the real Stripe.
  const stripe = await startFakeStripe();
  cleanups.push(() => stripe.close());

  // Single sign-on (A13): the identity provider sends people back through Studio's origin.
  const idp = await startE2eIdp(ports.idp, `${studioOrigin}/api/auth/sso/callback/`);
  cleanups.push(() => idp.close());
  writeFileSync(dnsRecords, '{}');
  cleanups.push(await startDnsServer(ports.dns, dnsRecords));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Tests never call the real Jev, even where the shell holds a TypeSafe key.
    TYPESAFE_API_KEY: '',
    TYPESAFE_BASE_URL: '',
    JEV_API_KEY: '',
    JEV_BASE_URL: '',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(ports.api),
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    DATABASE_URL: database.app,
    DATABASE_PLATFORM_URL: database.platform,
    REDIS_URL: redisUrl,
    HAMNIVO_KEK_BASE64: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    PUBLIC_API_ORIGIN: studioOrigin,
    PUBLIC_CONSOLE_ORIGIN: studioOrigin,
    PUBLIC_WIDGET_ORIGIN: origin(ports.widget),
    // Sign-up goes straight in; the "check your email" state is covered separately.
    REQUIRE_EMAIL_VERIFICATION: 'false',
    STEP_UP_MAX_AGE_MINUTES: '10',
    CHATWOOT_URL: fake.url,
    CHATWOOT_PLATFORM_TOKEN: fake.platformToken,
    CHATWOOT_WEBHOOK_BASE_URL: origin(ports.api),
    STREAM_HEARTBEAT_SECONDS: '5',
    RATE_LIMIT_PER_MINUTE: '100000',
    // Workspaces without plan limits, and brands connected by hand, as these journeys expect.
    HAMNIVO_DEFAULT_PLAN: 'unlimited',
    CHATWOOT_AUTO_PROVISION: 'false',
    EMBEDDING_PROVIDER: 'mock',
    SSO_TRUSTED_IDP_ORIGINS: idp.issuer,
    SSO_DNS_SERVERS: `127.0.0.1:${ports.dns}`,
    COMMERCE_STRIPE_API_BASE: stripe.url,
    // The local webhook receiver: trusted by the administrator, so plain HTTP on 127.0.0.1 works.
    EGRESS_TRUSTED_ORIGINS: origin(ports.hooks),
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
  await hooksServer();
  await fakeControlServer(fake);
  await widgetServer();
  await studioServer();

  writeFileSync(
    join(root, 'apps/console/e2e/.stack.json'),
    JSON.stringify(
      {
        studioUrl: studioOrigin,
        apiBase: origin(ports.api),
        widgetOrigin: origin(ports.widget),
        databaseUrl: database.app,
        ownerDatabaseUrl: database.owner,
        idp: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
        dnsRecords,
        platformDatabaseUrl: database.platform,
        hooksUrl: origin(ports.hooks),
        stripe: { url: stripe.url, apiKey: stripe.apiKey },
        // The fake Chatwoot's platform API, to add channel inboxes to a brand's account.
        chatwoot: { url: fake.url, platformToken: fake.platformToken, control: origin(ports.fake) },
      },
      null,
      2,
    ),
  );
  console.log(`[e2e] stack ready: studio ${studioOrigin}, api ${origin(ports.api)}`);
} catch (error) {
  console.error('[e2e] stack failed:', error);
  await shutdown(1);
}
