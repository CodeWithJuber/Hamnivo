/**
 * Checks a running production stack (deploy/production) end to end, through its HTTPS edge.
 * Run by scripts/ci/production-smoke.sh, which starts the stack with Caddy's internal CA:
 *   tsx production-smoke.ts <stack .env> <Caddy root certificate> <hamnivo.sh>
 * hamnivo.sh is used for the backup and restore drill.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as plainRequest } from 'node:http';
import { request } from 'node:https';

const [envFile = '', caFile = '', hamnivo = ''] = process.argv.slice(2);
const ca = readFileSync(caFile);
// biome-ignore lint/suspicious/noExplicitAny: API responses are checked field by field below.
type Json = any;

const settings = new Map(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const [key = '', ...rest] = line.split('=');
      return [key, rest.join('=').replace(/^"(.*)"$/, '$1')] as const;
    }),
);
const setting = (key: string) => {
  const value = settings.get(key);
  if (!value) throw new Error(`${key} is not set in ${envFile}`);
  return value;
};
const API = setting('HAMNIVO_API_ORIGIN');
const APP = setting('HAMNIVO_APP_ORIGIN');
const CHAT = setting('HAMNIVO_CHAT_ORIGIN');
const SUPPORT = setting('HAMNIVO_SUPPORT_ORIGIN');
const SITE = setting('HAMNIVO_SITE_ORIGIN');
const HOST_PAGE = 'https://shop.hamnivo.example';

interface Reply<T = Json> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: T;
}

/**
 * HTTPS to the edge on this machine, whatever the name resolves to, trusting only Caddy's CA. Each
 * request opens a new connection: the restore drill restarts the edge, which kills pooled ones.
 */
function call<T = Json>(
  method: string,
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; cookies?: Map<string, string> } = {},
): Promise<Reply<T>> {
  const target = new URL(url);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        host: '127.0.0.1',
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        ca,
        agent: false,
        headers: {
          host: target.host,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(options.cookies?.size
            ? { cookie: [...options.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
            : {}),
          ...options.headers,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          for (const line of [res.headers['set-cookie'] ?? []].flat()) {
            const [pair = ''] = line.split(';');
            const [name = '', ...rest] = pair.split('=');
            if (options.cookies && name) options.cookies.set(name.trim(), rest.join('='));
          }
          let body: unknown = text;
          if (String(res.headers['content-type'] ?? '').includes('json') && text) {
            body = JSON.parse(text);
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: body as T });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${url}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Reads Server-Sent Events until `done` returns true for the events seen so far. */
function readStream(
  url: string,
  token: string,
  done: (events: Json[]) => boolean,
  timeoutMs = 120_000,
): Promise<Json[]> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const events: Json[] = [];
    let buffer = '';
    const req = request({
      host: '127.0.0.1',
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      ca,
      agent: false,
      headers: {
        host: target.host,
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
        'last-event-id': '0',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`stream condition not met: ${JSON.stringify(events.map((e) => e.type))}`));
    }, timeoutMs);
    req.on('response', (res) => {
      if (res.statusCode !== 200) reject(new Error(`stream status ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const kind = /^event: (.*)$/m.exec(frame)?.[1];
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (data && kind !== 'control') events.push(JSON.parse(data));
          if (done(events)) {
            clearTimeout(timer);
            req.destroy();
            resolve(events);
            return;
          }
          end = buffer.indexOf('\n\n');
        }
      });
    });
    req.on('error', (error) => {
      if (!events.length || !done(events)) reject(error);
    });
    req.end();
  });
}

let failures = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await run();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const staff = new Map<string, string>();
const admin = (method: string, path: string, body?: unknown, tenant?: string) =>
  call(method, `${API}${path}`, {
    ...(body === undefined ? {} : { body }),
    cookies: staff,
    headers: { origin: APP, ...(tenant ? { 'x-hamnivo-tenant': tenant } : {}) },
  });

let tenantId = '';
let brand = { id: '', widgetId: '' };
let conversationId = '';
let widgetToken = '';

console.log('Production smoke test');

await check('the API is healthy behind HTTPS', async () => {
  const health = await call('GET', `${API}/health/ready`);
  expect(health.status === 200, `health ${health.status}: ${health.text}`);
  expect(
    String(health.headers['strict-transport-security'] ?? '').includes('max-age'),
    'no HSTS header',
  );
});

await check('a staff member signs up and creates a company', async () => {
  const email = `owner-${Date.now()}@hamnivo.example`;
  const signUp = await admin('POST', '/api/auth/sign-up/email', {
    name: 'Smoke Owner',
    email,
    password: 'correct horse battery staple',
  });
  expect(signUp.status === 200, `sign-up ${signUp.status}: ${signUp.text}`);
  expect(
    [...staff.keys()].some((name) => name.startsWith('__Secure-')),
    `session cookie is not marked secure: ${[...staff.keys()].join(', ')}`,
  );
  const tenant = await admin('POST', '/v1/tenants', { name: 'Smoke Store', slug: 'smoke-store' });
  expect(tenant.status === 201, `tenant ${tenant.status}: ${tenant.text}`);
  tenantId = tenant.body.tenant.id;
});

await check('a brand connects to the real Chatwoot and its AI agent is published', async () => {
  const workspaces = await admin('GET', '/v1/admin/workspaces', undefined, tenantId);
  const created = await admin(
    'POST',
    '/v1/admin/brands',
    { workspaceId: workspaces.body.items[0].id, name: 'Smoke Shop', allowedOrigins: [HOST_PAGE] },
    tenantId,
  );
  expect(created.status === 201, `brand ${created.status}: ${created.text}`);
  brand = created.body;
  const connection = await admin(
    'POST',
    '/v1/admin/authority/connections',
    { brandId: brand.id },
    tenantId,
  );
  expect(connection.status === 201, `connect ${connection.status}: ${connection.text}`);
  const agents = await admin('GET', '/v1/admin/agents', undefined, tenantId);
  const agent = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.id);
  const published = await admin('POST', `/v1/admin/agents/${agent.id}/publish`, {}, tenantId);
  expect(published.status === 200, `publish ${published.status}: ${published.text}`);
});

await check('the widget page may only be framed by the brand’s websites', async () => {
  const page = await call('GET', `${CHAT}/?widgetId=${brand.widgetId}&host=${HOST_PAGE}`);
  expect(page.status === 200, `widget page ${page.status}`);
  const csp = String(page.headers['content-security-policy'] ?? '');
  expect(csp.includes(`frame-ancestors ${HOST_PAGE}`), `CSP was: ${csp}`);
  expect(csp.includes(`connect-src 'self' ${API}`), `CSP was: ${csp}`);
  expect(page.text.includes('<div id="root">'), 'not the widget page');
  const spoofed = await call('GET', `${CHAT}/?widgetId=${brand.widgetId}`, {
    headers: { 'x-hamnivo-frame-ancestors': '*' },
  });
  expect(
    String(spoofed.headers['content-security-policy']).includes(`frame-ancestors ${HOST_PAGE}`),
    'a client header changed the policy',
  );
  const unknown = await call('GET', `${CHAT}/?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0cd`);
  expect(unknown.status === 404, `unknown widget ${unknown.status}`);
  const loader = await call('GET', `${CHAT}/loader.js`);
  expect(loader.status === 200 && loader.text.length > 500, `loader ${loader.status}`);
});

await check('a customer chats and the AI answers over the live stream', async () => {
  const session = await call('POST', `${API}/v1/widget/sessions`, {
    body: { widgetId: brand.widgetId, hostOrigin: HOST_PAGE },
    headers: { origin: CHAT },
  });
  expect(session.status === 201, `session ${session.status}: ${session.text}`);
  expect(
    session.headers['access-control-allow-origin'] === CHAT,
    'the widget origin is not allowed',
  );
  widgetToken = session.body.accessToken;
  const started = await call('POST', `${API}/v1/widget/conversations`, {
    body: { firstMessage: 'Assalamu alaikum, where is my order?' },
    headers: { origin: CHAT, authorization: `Bearer ${widgetToken}` },
  });
  expect(started.status === 201, `conversation ${started.status}: ${started.text}`);
  conversationId = started.body.id;
  const events = await readStream(
    `${API}/v1/widget/conversations/${conversationId}/events`,
    widgetToken,
    (seen) => seen.some((e) => e.data?.message?.sender?.kind === 'ai_agent'),
  );
  const reply = events.find((e) => e.data?.message?.sender?.kind === 'ai_agent');
  expect(reply, 'no AI reply');
});

await check('plain HTTP redirects to HTTPS', async () => {
  const port = setting('HAMNIVO_HTTP_PORT');
  const status = await new Promise<number>((resolve, reject) => {
    const req = plainRequest(
      { host: '127.0.0.1', port, path: '/health/live', headers: { host: new URL(API).hostname } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status === 308 || status === 301, `HTTP answered ${status}`);
});

await check('the website and Chatwoot answer', async () => {
  const home = await call('GET', `${SITE}/`);
  expect(home.status === 200 && home.text.includes('lang="en"'), `website ${home.status}`);
  const urdu = await call('GET', `${SITE}/ur/`);
  expect(urdu.status === 200 && urdu.text.includes('dir="rtl"'), `Urdu page ${urdu.status}`);
  const chatwoot = await call('GET', `${SUPPORT}/api`);
  expect(chatwoot.status === 200, `Chatwoot ${chatwoot.status}`);
  expect(String(chatwoot.body.version).startsWith('4.18'), `Chatwoot ${chatwoot.text}`);
});

await check('a backup restores the data as it was', async () => {
  const backups = `${envFile}.backups`;
  execFileSync('bash', [hamnivo, 'backup', '--to', backups], { stdio: 'inherit' });
  const dir = execFileSync('bash', ['-c', `ls -d "${backups}"/20*Z | tail -1`], {
    encoding: 'utf8',
  }).trim();
  const workspaces = await admin('GET', '/v1/admin/workspaces', undefined, tenantId);
  const later = await admin(
    'POST',
    '/v1/admin/brands',
    { workspaceId: workspaces.body.items[0].id, name: 'Made after the backup', allowedOrigins: [] },
    tenantId,
  );
  expect(later.status === 201, `second brand ${later.status}`);
  execFileSync('bash', [hamnivo, 'restore', dir, '--yes'], { stdio: 'inherit' });
  const brands = await admin('GET', '/v1/admin/brands', undefined, tenantId);
  expect(brands.status === 200, `brands after restore ${brands.status}: ${brands.text}`);
  const names = brands.body.items.map((b: { name: string }) => b.name);
  expect(
    names.includes('Smoke Shop') && !names.includes('Made after the backup'),
    `brands after restore: ${names.join(', ')}`,
  );
  const history = await call(
    'GET',
    `${API}/v1/widget/conversations/${conversationId}/messages?limit=20`,
    { headers: { authorization: `Bearer ${widgetToken}` } },
  );
  expect(history.status === 200, `history ${history.status}: ${history.text}`);
  const kinds = history.body.items.map((m: { sender: { kind: string } }) => m.sender.kind);
  expect(kinds.includes('ai_agent'), `history after restore: ${kinds.join(', ')}`);
});

if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All production checks passed.');
