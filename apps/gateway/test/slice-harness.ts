import { createServer } from 'node:net';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { CacheStore } from '@hamnivo/adapters/cache';
import { createMockModel } from '@hamnivo/adapters/models';
import { type FakeChatwoot, startFakeChatwoot } from '@hamnivo/chatwoot/fake';
import { closeDb, createDb, type Db } from '@hamnivo/db';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { LanguageModel } from 'ai';
import { type EventSourceMessage, EventSourceParserStream } from 'eventsource-parser/stream';
import { InboxProcessor } from '../src/authority/processor.service.js';
import { ReconcilerService } from '../src/authority/reconciler.service.js';
import type { PersonalCacheScope } from '../src/cache/store.js';
import { loadConfig } from '../src/config.js';
import type { Scanner } from '../src/knowledge/scanner.js';
import { OutboxRelay } from '../src/outbox/relay.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { Client, type Gateway, signUp, startGateway, testEnv } from './harness.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export interface Slice {
  gw: Gateway;
  fake: FakeChatwoot;
  worker: INestApplicationContext;
  app: Db;
  baseUrl: string;
  /** Delivers webhooks and runs the worker until nothing is left to do. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Gateway on a real port, a worker driven by hand, and a fake Chatwoot that calls back over HTTP. */
export async function startSlice(
  options: {
    clock?: () => Date;
    model?: LanguageModel;
    scanner?: Scanner;
    /** A fake Jev transport for decision providers. */
    decisionFetch?: typeof fetch;
    /** A cache store to use instead of Valkey (for outage tests). */
    cacheStore?: CacheStore;
    /** Places entries private to one customer (memory provides it in production). */
    personalCacheScope?: PersonalCacheScope;
  } = {},
): Promise<Slice> {
  const fake = await startFakeChatwoot();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    CHATWOOT_URL: fake.url,
    CHATWOOT_PLATFORM_TOKEN: fake.platformToken,
    CHATWOOT_WEBHOOK_BASE_URL: baseUrl,
    PUBLIC_API_ORIGIN: baseUrl,
    STREAM_HEARTBEAT_SECONDS: '1',
  };
  const shared = {
    ...(options.decisionFetch ? { decisionFetch: options.decisionFetch } : {}),
    ...(options.cacheStore ? { cacheStore: options.cacheStore } : {}),
    ...(options.personalCacheScope ? { personalCacheScope: options.personalCacheScope } : {}),
  };
  const gw = await startGateway(env, undefined, {
    ...(options.clock ? { clock: options.clock } : {}),
    ...shared,
  });
  await gw.app.listen(port, '127.0.0.1');
  const config = loadConfig(
    testEnv(gw.database, {
      ...env,
      BETTER_AUTH_SECRET: gw.config.BETTER_AUTH_SECRET,
      HAMNIVO_KEK_BASE64: gw.config.HAMNIVO_KEK_BASE64,
      CACHE_KEY_PREFIX: gw.config.CACHE_KEY_PREFIX,
    }),
  );
  const worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, {
      ...shared,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.scanner ? { scanner: options.scanner } : {}),
    }),
    { logger: false },
  );
  // Drive the worker by hand for deterministic tests.
  await worker.get(OutboxRelay).onApplicationShutdown();
  await worker.get(InboxProcessor).onApplicationShutdown();
  await worker.get(ReconcilerService).onApplicationShutdown();
  const app = createDb(gw.database.app, { max: 2 });
  return {
    gw,
    fake,
    worker,
    app,
    baseUrl,
    async drain() {
      for (let round = 0; round < 20; round += 1) {
        await fake.flush();
        const processed = await worker.get(InboxProcessor).drainOnce();
        const relayed = await worker.get(OutboxRelay).drainOnce();
        await fake.flush();
        if (processed === 0 && relayed === 0) return;
      }
      throw new Error('worker did not settle');
    },
    async close() {
      await worker.close();
      await closeDb(app);
      await gw.close();
      await fake.close();
    },
  };
}

/** A tenant owner with a brand connected to the fake Chatwoot. */
export async function connectedTenant(
  slice: Slice,
  label: string,
  options: { publishAgent?: boolean } = {},
) {
  const owner = await signUp(slice.gw, `${label} Owner`, `${label}-owner@example.com`);
  const tenant = await owner.post('/v1/tenants', {
    name: `${label} Store`,
    slug: `${label}-store`,
  });
  if (tenant.status !== 201)
    throw new Error(`tenant: ${tenant.status} ${JSON.stringify(tenant.body)}`);
  owner.tenant = tenant.body.tenant.id;
  const workspaces = await owner.get('/v1/admin/workspaces');
  const workspaceId = workspaces.body.items[0].id as string;
  const brand = await owner.post('/v1/admin/brands', {
    workspaceId,
    name: `${label} Shop`,
    allowedOrigins: [`https://${label}.example`],
  });
  if (brand.status !== 201) throw new Error(`brand: ${brand.status} ${JSON.stringify(brand.body)}`);
  const connection = await owner.post('/v1/admin/authority/connections', {
    brandId: brand.body.id,
  });
  if (connection.status !== 201) {
    throw new Error(`connect: ${connection.status} ${JSON.stringify(connection.body)}`);
  }
  // Connecting creates the brand's default agent as a draft; publishing lets the AI answer.
  const agents = await owner.get('/v1/admin/agents');
  const agentId = agents.body.items.find((a: { brandId: string }) => a.brandId === brand.body.id)
    ?.id as string;
  if (options.publishAgent !== false) {
    const published = await owner.post(`/v1/admin/agents/${agentId}/publish`, {});
    if (published.status !== 200) {
      throw new Error(`publish: ${published.status} ${JSON.stringify(published.body)}`);
    }
  }
  return {
    owner,
    agentId,
    tenantId: owner.tenant as string,
    workspaceId,
    brand: brand.body as { id: string; widgetId: string },
    connection: connection.body as {
      id: string;
      accountId: number;
      inboxes: { externalInboxId: number }[];
    },
    hostOrigin: `https://${label}.example`,
  };
}

/** A widget visitor talking to the gateway over HTTP, as the iframe would. */
export class Visitor {
  accessToken = '';
  refreshToken = '';
  principalId = '';

  constructor(
    private readonly baseUrl: string,
    readonly widgetId: string,
    readonly hostOrigin: string,
  ) {}

  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : undefined) as T,
      headers: response.headers,
    };
  }

  adopt(session: { accessToken: string; refreshToken: string; principal: { id: string } }) {
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.principalId = session.principal.id;
  }

  async open() {
    const session = await this.call('POST', '/v1/widget/sessions', {
      widgetId: this.widgetId,
      hostOrigin: this.hostOrigin,
    });
    if (session.status !== 201)
      throw new Error(`session: ${session.status} ${JSON.stringify(session.body)}`);
    this.adopt(session.body);
    return session.body;
  }

  stream(conversationId: string, lastEventId?: number): Stream {
    return new Stream(
      `${this.baseUrl}/v1/widget/conversations/${conversationId}/events`,
      this.accessToken,
      lastEventId,
    );
  }
}

/** A Server-Sent Events reader over fetch (as the widget SDK reads streams). */
export class Stream {
  readonly messages: EventSourceMessage[] = [];
  ended = false;
  private readonly controller = new AbortController();
  readonly ready: Promise<Response>;

  constructor(url: string, token: string, lastEventId?: number) {
    this.ready = fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}),
      },
      signal: this.controller.signal,
    });
    void this.ready
      .then(async (response) => {
        if (!response.body) return;
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.messages.push(value);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.ended = true;
      });
  }

  /** Journal events (not control frames) as parsed envelopes. */
  get events(): Array<Record<string, any>> {
    return this.messages.filter((m) => m.event !== 'control').map((m) => JSON.parse(m.data));
  }

  get controls(): Array<Record<string, any>> {
    return this.messages.filter((m) => m.event === 'control').map((m) => JSON.parse(m.data));
  }

  async until(predicate: (s: Stream) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline) {
        throw new Error(
          `stream condition not met; got ${JSON.stringify(this.messages.map((m) => m.event))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close() {
    this.controller.abort();
  }
}

export { Client, signUp };

/** The mock model, with an async hook that runs while a reply is being generated. */
export function hookedModel() {
  const base = createMockModel();
  const state: { during: (() => Promise<void>) | null } = { during: null };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      const hook = state.during;
      state.during = null;
      if (hook) await hook();
      return base.doGenerate(call);
    },
  };
  return { model, state };
}
