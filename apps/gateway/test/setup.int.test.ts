import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import type { ResolvedAddress } from '@hamnivo/adapters/net';
import { MODEL_PROBE_MESSAGES } from '@hamnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_ORIGIN } from './harness.js';
import { customerStarts, join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * What a business owner sets up from Studio alone, in the API: AI keys and their test (A06, G02),
 * the look of the chat (W03), the test chat (A01) and the setup wizard's progress. The model
 * provider is a local server the administrator trusts; no real provider is ever called.
 */

/** What the fake model server answers with next. */
type Mode = 'ok' | 'wrong_key' | 'no_credit' | 'model' | 'busy' | 'drop';
let mode: Mode = 'ok';
const seen: { url: string; authorization: string | undefined; body: Record<string, unknown> }[] =
  [];
let modelServer: Server;
let modelOrigin = '';

/** Counts connections: a refused address must never get this far. */
let sink: SocketServer;
let sinkPort = 0;
let sinkConnections = 0;

const dns: Record<string, string[]> = { 'llm.partner.example': ['93.184.216.34'] };

const SERVER_KEY = 'sk-ant-server-wide-key-0001';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;

const answers: Record<Exclude<Mode, 'ok' | 'drop'>, [number, unknown]> = {
  wrong_key: [
    401,
    {
      error: {
        message: 'Incorrect API key provided.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
  ],
  no_credit: [
    429,
    {
      error: {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    },
  ],
  model: [
    404,
    {
      error: {
        message: 'The model does not exist.',
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    },
  ],
  busy: [
    503,
    {
      error: {
        message: 'Overloaded.',
        type: 'service_unavailable_error',
        code: 'server_is_overloaded',
      },
    },
  ],
};

beforeAll(async () => {
  sink = createSocketServer((socket) => {
    sinkConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  sinkPort = (sink.address() as AddressInfo).port;

  modelServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      seen.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: text ? JSON.parse(text) : {},
      });
      if (mode === 'drop') {
        request.socket.destroy();
        return;
      }
      const failure = mode === 'ok' ? undefined : answers[mode];
      response.writeHead(failure?.[0] ?? 200, { 'content-type': 'application/json' }).end(
        JSON.stringify(
          failure?.[1] ?? {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'test-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  modelOrigin = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

  slice = await startSlice({
    env: { EGRESS_TRUSTED_ORIGINS: modelOrigin, ANTHROPIC_API_KEY: SERVER_KEY },
    egressResolver: async (host): Promise<ResolvedAddress[]> => {
      const addresses = dns[host];
      if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
  shop = await connectedTenant(slice, 'setup');
});

afterAll(async () => {
  await slice?.close();
  modelServer?.closeAllConnections();
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
  await new Promise<void>((resolve) => sink?.close(() => resolve()));
});

const connect = (extra: Record<string, unknown> = {}) =>
  shop.owner.post('/v1/admin/model-connections', {
    provider: 'openai-compatible',
    label: 'Our model server',
    baseUrl: `${modelOrigin}/v1`,
    apiKey: 'sk-test-first-key-0001',
    allowedModels: ['test-model'],
    ...extra,
  });

async function testKey(connectionId: string, body: Record<string, unknown> = {}) {
  seen.length = 0;
  return shop.owner.post(`/v1/admin/model-connections/${connectionId}/test`, body);
}

describe('which keys the server holds', () => {
  it('says yes or no for each key and for Jev, and never shows a value', async () => {
    const status = await shop.owner.get('/v1/admin/model-connections/status');
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body).toEqual({
      serverKeys: { anthropic: true, openai: false, google: false, openaiCompatible: false },
      jev: { configured: false },
      embeddings: { provider: 'mock', ready: true },
      tests: [],
    });
    expect(JSON.stringify(status.body)).not.toContain(SERVER_KEY);
  });

  it('is for people who manage integrations, and for no one signed out', async () => {
    const agent = await join(slice, shop, 'Amal Agent', 'agent');
    for (const path of ['status']) {
      expect((await agent.client.get(`/v1/admin/model-connections/${path}`)).status).toBe(403);
    }
    const created = await connect();
    const id = created.body.id as string;
    expect((await agent.client.post(`/v1/admin/model-connections/${id}/test`, {})).status).toBe(
      403,
    );
    expect(
      (
        await agent.client.post(`/v1/admin/model-connections/${id}/rotate`, {
          apiKey: 'sk-test-another-key-9999',
        })
      ).status,
    ).toBe(403);
    const signedOut = await fetch(`${slice.baseUrl}/v1/admin/model-connections/status`, {
      headers: { 'x-hamnivo-tenant': shop.tenantId },
    });
    expect(signedOut.status).toBe(401);
  });
});

describe('testing a key', () => {
  it('makes one small real call with the connection’s key, and says it worked', async () => {
    mode = 'ok';
    const created = await connect();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const result = await testKey(created.body.id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      kind: 'ok',
      message: MODEL_PROBE_MESSAGES.ok,
      modelId: 'test-model',
    });
    expect(result.body.latencyMs).toBeGreaterThanOrEqual(0);
    // One request, with the stored key and only a few tokens asked for.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: '/v1/chat/completions',
      authorization: 'Bearer sk-test-first-key-0001',
    });
    const asked = seen[0]?.body ?? {};
    expect(asked.model).toBe('test-model');
    expect(asked.max_tokens ?? asked.max_completion_tokens).toBe(16);
    // The answer carries nothing of the key.
    expect(JSON.stringify(result.body)).not.toContain('sk-test-first-key');
  });

  it('says in plain words what is wrong: the key, the credit, the model, the provider, the network', async () => {
    const created = await connect();
    const expected: [Mode, string][] = [
      ['wrong_key', 'wrong_key'],
      ['no_credit', 'no_credit'],
      ['model', 'model_not_found'],
      ['busy', 'unavailable'],
      ['drop', 'network'],
    ];
    for (const [next, kind] of expected) {
      mode = next;
      const result = await testKey(created.body.id);
      expect(result.status, next).toBe(200);
      expect(result.body, next).toMatchObject({
        ok: false,
        kind,
        message: MODEL_PROBE_MESSAGES[kind as keyof typeof MODEL_PROBE_MESSAGES],
      });
      // Tried once: no retries.
      expect(seen, next).toHaveLength(1);
    }
    mode = 'ok';
  });

  it('keeps the last result for each connection, and records the test without the key', async () => {
    const created = await connect({ label: 'Remembered' });
    mode = 'wrong_key';
    await testKey(created.body.id);
    mode = 'ok';
    await testKey(created.body.id);
    const status = await shop.owner.get('/v1/admin/model-connections/status');
    const mine = status.body.tests.filter(
      (t: { connectionId: string }) => t.connectionId === created.body.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ok: true, kind: 'ok', modelId: 'test-model' });
    const audit = await shop.owner.get('/v1/admin/audit?action=model_connection.tested&limit=100');
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const mineAudit = audit.body.items.filter(
      (event: { target: { id: string } }) => event.target.id === created.body.id,
    );
    expect(mineAudit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.body)).not.toContain('sk-test-first-key');
  });

  it('tests the model asked for, or the connection’s first, or the provider’s recommended one', async () => {
    mode = 'ok';
    const open = await connect({ allowedModels: [] });
    // An OpenAI-compatible server names its own models: there is nothing to start from.
    const nameless = await testKey(open.body.id);
    expect(nameless.status).toBe(422);
    expect(nameless.body.fields[0]).toMatchObject({ path: 'modelId' });
    expect((await testKey(open.body.id, { modelId: 'qwen3:8b' })).body.modelId).toBe('qwen3:8b');
    expect(seen[0]?.body.model).toBe('qwen3:8b');

    // A provider with a list starts from its recommended model.
    const openai = await connect({ provider: 'openai', allowedModels: [], label: 'OpenAI' });
    expect(openai.status, JSON.stringify(openai.body)).toBe(201);
    const recommended = await testKey(openai.body.id);
    expect(recommended.body).toMatchObject({ ok: true, modelId: 'gpt-5.4-mini' });
    expect(seen[0]?.body.model).toBe('gpt-5.4-mini');

    // A connection that allows one model is not tested with another.
    const narrow = await connect({ allowedModels: ['test-model'] });
    const other = await testKey(narrow.body.id, { modelId: 'something-else' });
    expect(other.status).toBe(422);
    expect(other.body.fields[0].message).toContain('test-model');
  });

  it('refuses a switched-off or unknown connection', async () => {
    const created = await connect();
    await shop.owner.post(`/v1/admin/model-connections/${created.body.id}/disable`);
    const off = await testKey(created.body.id);
    expect(off.status).toBe(422);
    expect(off.body.detail).toMatch(/turned off/);
    expect((await testKey('mcn_01j9zk7w3xq8r4t2v6m5n1p0cd')).status).toBe(404);
    expect((await testKey('not-an-id')).status).toBe(404);
  });

  it('sends nothing to an address that turned private after it was saved', async () => {
    dns['llm.partner.example'] = ['93.184.216.34'];
    const created = await connect({ baseUrl: `https://llm.partner.example:${sinkPort}/v1` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    dns['llm.partner.example'] = ['127.0.0.1'];
    const before = sinkConnections;
    try {
      const result = await testKey(created.body.id);
      expect(result.body).toMatchObject({ ok: false, kind: 'blocked' });
      expect(sinkConnections).toBe(before);
    } finally {
      dns['llm.partner.example'] = ['93.184.216.34'];
    }
  });
});

describe('replacing a key in place', () => {
  it('keeps the connection, uses the new key from then on and forgets the old test', async () => {
    mode = 'ok';
    const created = await connect({ label: 'Rotating' });
    await testKey(created.body.id);
    const before = (await shop.owner.get('/v1/admin/model-connections')).body.items.find(
      (c: { id: string }) => c.id === created.body.id,
    );
    expect(before.keyHint).toBe('0001');

    const rotated = await shop.owner.post(`/v1/admin/model-connections/${created.body.id}/rotate`, {
      apiKey: 'sk-test-second-key-7777',
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body).toMatchObject({
      id: created.body.id,
      label: 'Rotating',
      status: 'active',
      keyHint: '7777',
    });
    expect(JSON.stringify(rotated.body)).not.toContain('sk-test-second-key');

    const tests = (await shop.owner.get('/v1/admin/model-connections/status')).body.tests;
    expect(tests.some((t: { connectionId: string }) => t.connectionId === created.body.id)).toBe(
      false,
    );
    await testKey(created.body.id);
    expect(seen[0]?.authorization).toBe('Bearer sk-test-second-key-7777');

    const audit = await shop.owner.get('/v1/admin/audit?action=model_connection.key_replaced');
    expect(audit.body.items[0]).toMatchObject({
      action: 'model_connection.key_replaced',
      target: { type: 'model_connection', id: created.body.id },
    });
    expect(JSON.stringify(audit.body)).not.toContain('sk-test-second-key');
  });

  it('refuses a key that is too short, a connection that is off and one that does not exist', async () => {
    const created = await connect();
    const short = await shop.owner.post(`/v1/admin/model-connections/${created.body.id}/rotate`, {
      apiKey: 'short',
    });
    expect(short.status).toBe(422);
    await shop.owner.post(`/v1/admin/model-connections/${created.body.id}/disable`);
    const off = await shop.owner.post(`/v1/admin/model-connections/${created.body.id}/rotate`, {
      apiKey: 'sk-test-third-key-3333',
    });
    expect(off.status).toBe(422);
    expect(off.body.detail).toMatch(/turned off/);
    const missing = await shop.owner.post(
      '/v1/admin/model-connections/mcn_01j9zk7w3xq8r4t2v6m5n1p0cd/rotate',
      { apiKey: 'sk-test-third-key-3333' },
    );
    expect(missing.status).toBe(404);
  });
});

describe('how the chat looks', () => {
  const path = () => `/v1/admin/brands/${shop.brand.id}/appearance`;
  const open = () => new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();

  it('starts from Hamnivo’s own look and words', async () => {
    const got = await shop.owner.get(path());
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({
      brandId: shop.brand.id,
      appearance: {
        primaryColor: '#192A30',
        logoUrl: null,
        radius: 12,
        greeting: null,
        offlineText: null,
        csat: false,
        privacyUrl: null,
      },
      updatedAt: null,
    });
    const session = await open();
    expect(session.config.brand).toMatchObject({
      accent: '#192A30',
      onAccent: '#FFFFFF',
      radius: 12,
    });
    expect(session.config.copy.en.greeting).toMatch(/How can we help today/);
    expect(session.config.features.csat).toBe(false);
    expect(session.config.privacyPolicyUrl).toBeNull();
  });

  it('saves the colour, logo, corners, greeting, rating and privacy link, and the chat uses them at once', async () => {
    const before = (await open()).config.version;
    const saved = await shop.owner.put(path(), {
      primaryColor: '#0b5d3b',
      logoUrl: 'https://cdn.noor.example/logo.png',
      radius: 4,
      greeting: { en: 'Welcome to Noor Books!', ar: 'أهلاً بكم في نور!' },
      offlineText: { en: 'We are away. Back {when}.' },
      csat: true,
      privacyUrl: 'https://noor.example/privacy',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.appearance.primaryColor).toBe('#0B5D3B');
    expect(saved.body.configVersion).toBe(before + 1);
    expect((await shop.owner.get(path())).body.appearance).toEqual(saved.body.appearance);

    const session = await open();
    expect(session.config.version).toBe(before + 1);
    expect(session.config.brand).toMatchObject({
      accent: '#0B5D3B',
      onAccent: '#FFFFFF',
      radius: 4,
      logoUrl: 'https://cdn.noor.example/logo.png',
    });
    // Words in a language the brand left empty show its English; a language it filled shows its own.
    expect(session.config.copy.en.greeting).toBe('Welcome to Noor Books!');
    expect(session.config.copy.ar.greeting).toBe('أهلاً بكم في نور!');
    expect(session.config.copy.hi.greeting).toBe('Welcome to Noor Books!');
    expect(session.config.features.csat).toBe(true);
    expect(session.config.privacyPolicyUrl).toBe('https://noor.example/privacy');

    const audit = await shop.owner.get('/v1/admin/audit?action=brand.appearance.updated');
    expect(audit.body.items[0].data).toMatchObject({
      before: { primaryColor: '#192A30' },
      after: { primaryColor: '#0B5D3B', csat: true },
    });
  });

  it('puts text on the colour that reads best, and the launcher in the same colours', async () => {
    const light = await shop.owner.put(path(), { primaryColor: '#d17b00' });
    expect(light.status, JSON.stringify(light.body)).toBe(200);
    const session = await open();
    expect(session.config.brand).toMatchObject({ accent: '#D17B00', onAccent: '#192A30' });
    const launcher = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}`,
      { headers: { origin: shop.hostOrigin } },
    );
    expect(launcher.status).toBe(200);
    expect(((await launcher.json()) as { launcher: object }).launcher).toMatchObject({
      accent: '#D17B00',
      onAccent: '#192A30',
    });
  });

  it('refuses a colour nobody can read, and says why', async () => {
    for (const primaryColor of ['#808080', '#f2f2f2']) {
      const refused = await shop.owner.put(path(), { primaryColor });
      expect(refused.status, primaryColor).toBe(422);
      expect(refused.body.fields[0].path).toBe('primaryColor');
      expect(refused.body.fields[0].message).toMatch(/contrast \d+\.\d\d:1/);
    }
    // Nothing was saved by the refusals.
    expect((await shop.owner.get(path())).body.appearance.primaryColor).toBe('#D17B00');
  });

  it('refuses addresses and sizes that cannot be right', async () => {
    const bad: Record<string, unknown>[] = [
      { logoUrl: 'http://cdn.noor.example/logo.png' },
      { logoUrl: 'https://user:pass@cdn.noor.example/logo.png' },
      { logoUrl: 'javascript:alert(1)' },
      { privacyUrl: 'ftp://noor.example/privacy' },
      { radius: 30 },
      { radius: -1 },
      { primaryColor: 'red' },
      { greeting: { en: '' } },
      { greeting: { en: 'x'.repeat(301) } },
    ];
    for (const change of bad) {
      const refused = await shop.owner.put(path(), change);
      expect(refused.status, JSON.stringify(change)).toBe(422);
    }
  });

  it('is for people who configure the chat', async () => {
    const agent = await join(slice, shop, 'Basma Agent', 'agent');
    expect((await agent.client.get(path())).status).toBe(403);
    expect((await agent.client.put(path(), { csat: true })).status).toBe(403);
    expect(
      (await shop.owner.get('/v1/admin/brands/brd_01j9zk7w3xq8r4t2v6m5n1p0cd/appearance')).status,
    ).toBe(404);
  });

  describe('the words shown when nobody is online', () => {
    const allDay = [{ open: '00:00', close: '24:00' }];
    const everyDay = {
      sun: allDay,
      mon: allDay,
      tue: allDay,
      wed: allDay,
      thu: allDay,
      fri: allDay,
      sat: allDay,
    };
    const never = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
    const today = () => new Date().toISOString().slice(0, 10);
    const setHours = (businessHours: unknown) =>
      shop.owner.put(`/v1/admin/brands/${shop.brand.id}/business-hours`, { businessHours });

    async function askForAPerson() {
      const guest = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
      await guest.open();
      const started = await guest.call('POST', '/v1/widget/conversations', {
        clientMessageId: randomUUID(),
        firstMessage: 'Is anyone there?',
      });
      await slice.drain();
      const handoff = await guest.call(
        'POST',
        `/v1/widget/conversations/${started.body.id}/handoff`,
        { clientRequestId: randomUUID() },
      );
      expect(handoff.status).toBe(200);
      return handoff.body as { message: string; followUp: unknown; availability: string };
    }

    it('uses the brand’s text, with the time people are back where it says {when}', async () => {
      await setHours({ timezone: 'UTC', weekly: everyDay, closedDates: [today()] });
      await shop.owner.put(path(), {
        offlineText: { en: 'We are closed. Back {when}. Thank you!' },
      });
      const handoff = await askForAPerson();
      expect(handoff.availability).toBe('offline');
      expect(handoff.message).toMatch(/^We are closed\. Back .+ UTC\. Thank you!$/);
      expect(handoff.message).not.toContain('{when}');
      expect(handoff.followUp).toMatchObject({ channel: 'this_chat' });
    });

    it('never shows a gap: with no time known, the built-in sentence says so', async () => {
      await setHours({ timezone: 'UTC', weekly: never, closedDates: [] });
      await shop.owner.put(path(), { offlineText: { en: 'We are closed. Back {when}.' } });
      const handoff = await askForAPerson();
      expect(handoff.message).toBe(
        'Our team is away right now. Your messages are kept here, and a person will read them.',
      );
      // Text that does not need a time is shown as it is.
      await shop.owner.put(path(), {
        offlineText: { en: 'Leave your question; we reply tomorrow.' },
      });
      expect((await askForAPerson()).message).toBe('Leave your question; we reply tomorrow.');
    });

    it('falls back to Hamnivo’s own words when the brand has none', async () => {
      await setHours({ timezone: 'UTC', weekly: everyDay, closedDates: [today()] });
      await shop.owner.put(path(), { offlineText: null });
      expect((await askForAPerson()).message).toMatch(
        /^Our team is away right now and answers again /,
      );
    });
  });
});

describe('the test chat in Studio', () => {
  const visitorFrom = (hostOrigin: string) =>
    new Visitor(slice.baseUrl, shop.brand.widgetId, hostOrigin);
  const session = (hostOrigin: string, test?: boolean) =>
    visitorFrom(hostOrigin).call('POST', '/v1/widget/sessions', {
      widgetId: shop.brand.widgetId,
      hostOrigin,
      ...(test === undefined ? {} : { test }),
    });
  const today = () => new Date().toISOString().slice(0, 10);

  it('lets Studio’s own page open a test chat, and no other page it was not given', async () => {
    // Studio is not one of the brand's websites: only a test chat may come from it.
    const real = await session(CONSOLE_ORIGIN);
    expect(real.status).toBe(403);
    expect(real.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    expect((await session(CONSOLE_ORIGIN, false)).status).toBe(403);
    expect((await session(CONSOLE_ORIGIN, true)).status).toBe(201);
    // A test chat does not open the widget to any other website.
    expect((await session('https://not-allowed.example', true)).status).toBe(403);
    // The brand's own website still works as before.
    expect((await session(shop.hostOrigin)).status).toBe(201);
    expect((await session(shop.hostOrigin, true)).status).toBe(201);
  });

  it('lets Studio frame the widget for a test chat only', async () => {
    const frame = async (query: string) => {
      const response = await fetch(
        `${slice.baseUrl}/v1/widget/frame-policy?widgetId=${shop.brand.widgetId}${query}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { frameAncestors: string[] };
      expect(response.headers.get('x-hamnivo-frame-ancestors')).toBe(body.frameAncestors.join(' '));
      return body.frameAncestors;
    };
    expect(await frame('')).toEqual([shop.hostOrigin]);
    expect(await frame('&test=0')).toEqual([shop.hostOrigin]);
    expect(await frame('&test=1')).toEqual([shop.hostOrigin, CONSOLE_ORIGIN]);
  });

  it('keeps a test session going, and a chat it starts out of reports and counts', async () => {
    const opened = await session(CONSOLE_ORIGIN, true);
    const tester = visitorFrom(CONSOLE_ORIGIN);
    tester.adopt(opened.body);
    const refreshed = await tester.call('POST', '/v1/widget/sessions/refresh', {
      refreshToken: tester.refreshToken,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    tester.adopt(refreshed.body);

    const inbox = async () => (await shop.owner.get('/v1/inbox/conversations?status=all')).body;
    const report = async () =>
      (await shop.owner.get(`/v1/admin/analytics/overview?from=${today()}&to=${today()}`)).body;
    const before = { inbox: await inbox(), report: await report() };

    const started = await tester.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Just trying the chat',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await slice.drain();

    // The owner can still see and answer it in the inbox, but nothing counts it.
    const afterInbox = await inbox();
    expect(afterInbox.items.map((i: { id: string }) => i.id)).toContain(started.body.id);
    expect(afterInbox.counts).toEqual(before.inbox.counts);
    expect((await report()).totals.conversations.value).toBe(
      before.report.totals.conversations.value,
    );

    // A real customer's chat is counted, and the test chat is still left out.
    await customerStarts(slice, shop, 'Where is my order?');
    await slice.drain();
    const afterReal = await inbox();
    expect(afterReal.counts.all).toBe(before.inbox.counts.all + 1);
    expect((await report()).totals.conversations.value).toBe(
      before.report.totals.conversations.value + 1,
    );
  });
});

describe('the setup wizard’s progress', () => {
  it('starts empty, remembers steps and the brand, and can be finished and taken back', async () => {
    const empty = await shop.owner.get('/v1/admin/onboarding');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body).toEqual({
      steps: {},
      brandId: null,
      finishedAt: null,
      updatedAt: null,
      useCase: null,
    });

    const first = await shop.owner.put('/v1/admin/onboarding', {
      steps: { workspace: 'done', brand: 'done', team: 'skipped' },
      brandId: shop.brand.id,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      steps: { workspace: 'done', brand: 'done', team: 'skipped' },
      brandId: shop.brand.id,
      finishedAt: null,
    });
    expect(first.body.updatedAt).toEqual(expect.any(String));

    // A later change keeps the rest; `null` takes a step back to "not yet".
    const second = await shop.owner.put('/v1/admin/onboarding', {
      steps: { engine: 'done', team: null },
    });
    expect(second.body.steps).toEqual({ workspace: 'done', brand: 'done', engine: 'done' });
    expect(second.body.brandId).toBe(shop.brand.id);

    const finished = await shop.owner.put('/v1/admin/onboarding', { finished: true });
    expect(finished.body.finishedAt).toEqual(expect.any(String));
    const stamp = finished.body.finishedAt;
    // Finishing again keeps the first time.
    expect((await shop.owner.put('/v1/admin/onboarding', { finished: true })).body.finishedAt).toBe(
      stamp,
    );
    const reopened = await shop.owner.put('/v1/admin/onboarding', {
      finished: false,
      brandId: null,
    });
    expect(reopened.body).toMatchObject({ finishedAt: null, brandId: null });
    expect((await shop.owner.get('/v1/admin/onboarding')).body.steps).toEqual(second.body.steps);
  });

  it('refuses what cannot be right', async () => {
    const put = (body: unknown) => shop.owner.put('/v1/admin/onboarding', body);
    expect((await put({})).status).toBe(422);
    expect((await put({ steps: { dance: 'done' } })).status).toBe(422);
    expect((await put({ steps: { team: 'maybe' } })).status).toBe(422);
    expect((await put({ brandId: 'brd_01j9zk7w3xq8r4t2v6m5n1p0cd' })).status).toBe(404);
    expect((await put({ brandId: 'not-an-id' })).status).toBe(422);
  });

  it('is for people who manage brands', async () => {
    const agent = await join(slice, shop, 'Chitra Agent', 'agent');
    expect((await agent.client.get('/v1/admin/onboarding')).status).toBe(403);
    expect((await agent.client.put('/v1/admin/onboarding', { finished: true })).status).toBe(403);
  });
});

describe('reviewing appearance before publication', () => {
  it('keeps drafts private, rejects stale editors and publishes one reviewed revision', async () => {
    const path = `/v1/admin/brands/${shop.brand.id}/appearance`;
    const initial = await shop.owner.get(path);
    const revision = initial.body.draftRevision;
    const before = initial.body.configVersion;
    const appearance = {
      ...initial.body.appearance,
      showBranding: false,
      launcherLabel: { en: 'Ask our team' },
    };
    const concurrent = await Promise.all([
      shop.owner.put(`${path}/draft`, { appearance, expectedRevision: revision }),
      shop.owner.put(`${path}/draft`, { appearance, expectedRevision: revision }),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    const saved = concurrent.find((r) => r.status === 200);
    expect(saved?.body.configVersion).toBe(before);
    expect(saved?.body.draftAppearance.launcherLabel.en).toBe('Ask our team');
    const preview = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(preview.config.version).toBe(before);
    expect(preview.config.brand.showBranding).toBe(initial.body.appearance.showBranding);
    expect((await shop.owner.post(`${path}/publish`, { expectedRevision: revision })).status).toBe(
      409,
    );
    const published = await shop.owner.post(`${path}/publish`, {
      expectedRevision: saved?.body.draftRevision,
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.draftAppearance).toBeNull();
    expect(published.body.configVersion).toBe(before + 1);
    const live = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(live.config.brand.showBranding).toBe(false);
    expect(live.config.copy.en.launcherLabel).toBe('Ask our team');
  });

  it('persists use case independently from readiness steps', async () => {
    const saved = await shop.owner.put('/v1/admin/onboarding', { useCase: 'billing' });
    expect(saved.status).toBe(200);
    expect(saved.body.useCase).toBe('billing');
    expect((await shop.owner.get('/v1/admin/onboarding')).body.useCase).toBe('billing');
    expect(saved.body.steps).not.toHaveProperty('useCase');
  });
});
