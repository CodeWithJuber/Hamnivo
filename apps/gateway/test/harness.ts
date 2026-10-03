import { randomBytes } from 'node:crypto';
import { closeDb, createDb, type Db } from '@hamnivo/db';
import { createTestDatabase, loadLocalEnv, type TestDatabase } from '@hamnivo/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';
import type { ApiOverrides } from '../src/api.module.js';
import { createApiApp } from '../src/app.js';
import { type AppConfig, loadConfig } from '../src/config.js';
import { MemoryMailer } from '../src/platform/mailer.js';

export const CONSOLE_ORIGIN = 'http://localhost:5173';

export interface Gateway {
  app: NestFastifyApplication;
  config: AppConfig;
  database: TestDatabase;
  mailer: MemoryMailer;
  owner: Db;
  close(): Promise<void>;
}

export function testEnv(
  database: TestDatabase,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.GATEWAY_TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: database.app,
    DATABASE_PLATFORM_URL: database.platform,
    DATABASE_POOL_MAX: '4',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    HAMNIVO_KEK_BASE64: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    PUBLIC_API_ORIGIN: 'http://localhost:4000',
    PUBLIC_CONSOLE_ORIGIN: CONSOLE_ORIGIN,
    RATE_LIMIT_PER_MINUTE: '100000',
    // Each test run keeps its cache entries apart on the shared Valkey.
    CACHE_KEY_PREFIX: `hv:test:${process.pid}:${randomBytes(4).toString('hex')}:`,
    // New workspaces get no plan and brands are connected by hand, unless a test says otherwise
    // (the SaaS tests do).
    HAMNIVO_DEFAULT_PLAN: 'unlimited',
    CHATWOOT_AUTO_PROVISION: 'false',
    ...extra,
  };
}

/** A gateway on a fresh migrated database, with an in-memory mailer. */
export async function startGateway(
  extraEnv: Record<string, string> = {},
  database?: TestDatabase,
  overrides: ApiOverrides = {},
): Promise<Gateway> {
  loadLocalEnv();
  const db = database ?? (await createTestDatabase(inject('templateDatabase')));
  const mailer = new MemoryMailer();
  const config = loadConfig(testEnv(db, extraEnv));
  const app = await createApiApp(config, { mailer, ...overrides });
  const owner = createDb(db.owner, { max: 1 });
  return {
    app,
    config,
    database: db,
    mailer,
    owner,
    async close() {
      await app.close();
      await closeDb(owner);
      if (!database) await db.drop();
    },
  };
}

export interface Reply<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

/** Minimal browser-like client: keeps cookies and sends the console Origin. */
export class Client {
  private readonly cookies = new Map<string, string>();
  tenant: string | undefined;

  /** The session cookies, for requests over real HTTP (streams). */
  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  constructor(private readonly app: NestFastifyApplication) {}

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; tenant?: string | null } = {},
  ): Promise<Reply<T>> {
    const tenant = options.tenant === null ? undefined : (options.tenant ?? this.tenant);
    const response = await this.app.inject({
      method,
      url,
      ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
      headers: {
        origin: CONSOLE_ORIGIN,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size > 0
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {}),
        ...(tenant ? { 'x-hamnivo-tenant': tenant } : {}),
        ...options.headers,
      },
    });
    const setCookie = response.headers['set-cookie'];
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = line.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (!name) continue;
      const value = rest.join('=');
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    const text = response.body;
    let body: unknown = text;
    // JSON and problem+json; NDJSON exports stay text.
    if (text && /[/+]json(?:;|$)/.test(String(response.headers['content-type'] ?? '')))
      body = JSON.parse(text);
    return { status: response.statusCode, body: body as T, headers: response.headers };
  }

  get = <T = any>(url: string, options?: Parameters<Client['request']>[2]) =>
    this.request<T>('GET', url, options);
  post = <T = any>(url: string, body?: unknown, options: Parameters<Client['request']>[2] = {}) =>
    this.request<T>('POST', url, { ...options, body: body ?? {} });
  put = <T = any>(url: string, body: unknown, options: Parameters<Client['request']>[2] = {}) =>
    this.request<T>('PUT', url, { ...options, body });
  patch = <T = any>(url: string, body: unknown, options: Parameters<Client['request']>[2] = {}) =>
    this.request<T>('PATCH', url, { ...options, body });
  delete = <T = any>(url: string, options?: Parameters<Client['request']>[2]) =>
    this.request<T>('DELETE', url, options);
}

export const PASSWORD = 'correct horse battery staple';

/** Signs up through Better Auth, follows the verification email and returns a signed-in client. */
export async function signUp(gateway: Gateway, name: string, email: string): Promise<Client> {
  const client = new Client(gateway.app);
  const created = await client.post('/api/auth/sign-up/email', { name, email, password: PASSWORD });
  if (created.status !== 200)
    throw new Error(`sign-up failed: ${created.status} ${JSON.stringify(created.body)}`);
  const mail = gateway.mailer.last(email, 'auth.verify-email');
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('no verification link sent');
  const url = new URL(link);
  const verified = await client.get(`${url.pathname}${url.search}`);
  if (verified.status >= 400) throw new Error(`verification failed: ${verified.status}`);
  return client;
}
