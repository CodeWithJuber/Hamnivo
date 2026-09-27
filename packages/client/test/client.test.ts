import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventStream, HamnivoClient, MemoryStorage, Outbox } from '../src/index.js';

const API = 'https://api.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let counter = 0;
function session(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    accessToken: `access-${counter}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `ses_x.refresh-${counter}`,
    principal: { id: 'cus_1', verified: false, displayName: null },
    config: {},
    conversations: [],
    ...overrides,
  };
}

const problem = (
  status: number,
  code: string,
  retryable: boolean,
  headers: Record<string, string> = {},
) =>
  HttpResponse.json(
    { status, code, retryable, title: code },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );

function client(storage = new MemoryStorage()) {
  return new HamnivoClient({
    apiBase: API,
    widgetId: 'wid_test',
    hostOrigin: 'https://shop.test',
    storage,
  });
}

describe('sessions', () => {
  it('stores the refresh token, resumes with it and renews once on a 401', async () => {
    const bodies: Record<string, unknown>[] = [];
    let expired = true;
    server.use(
      http.post(`${API}/v1/widget/sessions`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(session(), { status: 201 });
      }),
      http.post(`${API}/v1/widget/sessions/refresh`, async ({ request }) => {
        const { refreshToken } = (await request.json()) as { refreshToken: string };
        return HttpResponse.json(session({ refreshToken: `${refreshToken}-rotated` }));
      }),
      http.get(`${API}/v1/widget/conversations`, ({ request }) => {
        if (expired) {
          expired = false;
          return problem(401, 'SESSION_EXPIRED', false);
        }
        return HttpResponse.json({ items: [], auth: request.headers.get('authorization') });
      }),
    );
    const storage = new MemoryStorage();
    const c = client(storage);
    await c.connect();
    expect(storage.getItem('hamnivo:wid_test:refresh')).toMatch(/^ses_x\.refresh-/);
    const listed = await c.listConversations();
    expect((listed as unknown as { auth: string }).auth).toMatch(/^Bearer access-/);
    expect(storage.getItem('hamnivo:wid_test:refresh')).toMatch(/-rotated$/);
    // A new client on the same device resumes the stored session.
    await client(storage).connect();
    expect(bodies.at(-1)).toMatchObject({
      widgetId: 'wid_test',
      hostOrigin: 'https://shop.test',
      resumeToken: expect.stringMatching(/-rotated$/),
    });
  });
});

describe('customer memory', () => {
  it('calls the memory controls with the session and turns refusals into errors', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.get(`${API}/v1/widget/memory`, ({ request }) => {
        calls.push(`GET memory ${request.headers.get('authorization')?.slice(0, 13)}`);
        return HttpResponse.json({ offered: true, items: [] });
      }),
      http.post(`${API}/v1/widget/memory/consent`, async ({ request }) => {
        calls.push(`consent ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ state: 'granted' });
      }),
      http.post(`${API}/v1/widget/memory/:id/correct`, async ({ params, request }) => {
        calls.push(`correct ${params.id} ${JSON.stringify(await request.json())}`);
        return problem(422, 'VALIDATION_FAILED', false);
      }),
      http.post(`${API}/v1/widget/memory/:id/:action`, ({ params }) => {
        calls.push(`${params.action} ${params.id}`);
        return HttpResponse.json({ id: 'mdel_1' }, { status: 202 });
      }),
      http.post(`${API}/v1/widget/memory/forget`, () => {
        calls.push('forget');
        return HttpResponse.json({ id: 'mdel_2' }, { status: 202 });
      }),
      http.get(`${API}/v1/widget/memory/deletions/:id`, ({ params }) => {
        calls.push(`receipt ${params.id}`);
        return HttpResponse.json({ status: 'completed' });
      }),
    );
    const c = client();
    await c.getMemory();
    await c.setMemoryConsent('granted', 'memory-notice/1');
    await expect(c.correctMemory('mem_1', 'WhatsApp')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await c.confirmMemory('mem_2');
    await c.deleteMemory('mem_3');
    await c.forgetMemory();
    await c.getMemoryDeletion('mdel_1');
    expect(calls).toEqual([
      'GET memory Bearer access',
      'consent {"state":"granted","noticeVersion":"memory-notice/1"}',
      'correct mem_1 {"value":"WhatsApp"}',
      'confirm mem_2',
      'delete mem_3',
      'forget',
      'receipt mdel_1',
    ]);
  });
});

describe('identity changes', () => {
  it('are not undone by a token renewal still in flight', async () => {
    let parked: (() => void) | null = null;
    const resets: string[] = [];
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.post(`${API}/v1/widget/sessions/refresh`, async () => {
        await new Promise<void>((resolve) => {
          parked = resolve;
        });
        return HttpResponse.json(
          session({ accessToken: 'access-renewed', refreshToken: 'ses_x.renewed' }),
        );
      }),
      http.post(`${API}/v1/widget/sessions/reset`, ({ request }) => {
        resets.push(request.headers.get('authorization') ?? '');
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/v1/widget/identity`, () =>
        HttpResponse.json(session({ refreshToken: 'ses_x.verified' })),
      ),
    );
    /** Lets the parked renewal answer, once it is really waiting. */
    const finishRenewal = async () => {
      await vi.waitFor(() => expect(parked).not.toBeNull());
      const release = parked as unknown as () => void;
      parked = null;
      release();
    };
    const storage = new MemoryStorage();
    const c = client(storage);
    const key = 'hamnivo:wid_test:refresh';

    // Signing out while a renewal is in flight ends the renewed session and forgets it.
    await c.connect();
    const renewal = c.renew();
    const signedOut = c.reset();
    await vi.waitFor(() => expect(parked).not.toBeNull());
    expect(resets).toEqual([]);
    await finishRenewal();
    await Promise.all([renewal, signedOut]);
    expect(resets).toEqual(['Bearer access-renewed']);
    expect(storage.getItem(key)).toBeNull();
    expect(c.current).toBeNull();

    // Signing in while a renewal is in flight keeps the signed-in session.
    await c.connect();
    const second = c.renew();
    const signedIn = c.identify('header.payload.signature-of-a-real-assertion');
    await finishRenewal();
    await Promise.all([second, signedIn]);
    expect(storage.getItem(key)).toBe('ses_x.verified');
    expect(c.current?.refreshToken).toBe('ses_x.verified');
  });
});

describe('outbox', () => {
  it('retries retryable failures with the same message id and fails fast otherwise', async () => {
    const seen: string[] = [];
    let unavailable = 2;
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.post(`${API}/v1/widget/conversations/:id/messages`, async ({ request }) => {
        const body = (await request.json()) as {
          clientMessageId: string;
          parts: { text: string }[];
        };
        seen.push(body.clientMessageId);
        if (body.parts[0]?.text === 'bad') return problem(422, 'VALIDATION_FAILED', false);
        if (unavailable > 0) {
          unavailable -= 1;
          return problem(503, 'AUTHORITY_UNAVAILABLE', true);
        }
        return HttpResponse.json(
          { status: 'accepted', message: { id: 'msg_1', clientMessageId: body.clientMessageId } },
          { status: 202 },
        );
      }),
    );
    const c = client();
    await c.connect();
    const outbox = new Outbox(c, 'conv_1', () => 5);
    const item = outbox.enqueue('Assalamu alaikum');
    const bad = outbox.enqueue('bad');
    await expect
      .poll(() => outbox.messages.find((m) => m.clientMessageId === bad.clientMessageId)?.state)
      .toBe('failed');
    const sent = outbox.messages.find((m) => m.clientMessageId === item.clientMessageId);
    expect(sent).toMatchObject({ state: 'accepted', attempts: 3, message: { id: 'msg_1' } });
    expect(seen.filter((id) => id === item.clientMessageId)).toHaveLength(3);
    outbox.dispose();
  });

  it('keeps unsent messages across a reload and resends them with the same id', async () => {
    const storage = new MemoryStorage();
    let online = false;
    const seen: string[] = [];
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.post(`${API}/v1/widget/conversations/:id/messages`, async ({ request }) => {
        const body = (await request.json()) as { clientMessageId: string };
        seen.push(body.clientMessageId);
        if (!online) return HttpResponse.error();
        return HttpResponse.json(
          { status: 'duplicate', message: { id: 'msg_9' } },
          { status: 202 },
        );
      }),
    );
    const first = client(storage);
    await first.connect();
    const before = new Outbox(first, 'conv_2', () => 60_000);
    const draft = before.enqueue('my order number is 1042');
    await expect.poll(() => seen.length).toBe(1);
    before.dispose();
    expect(JSON.parse(storage.getItem('hamnivo:wid_test:outbox:conv_2') ?? '[]')).toHaveLength(1);

    online = true;
    const reloaded = client(storage);
    await reloaded.connect();
    const after = new Outbox(reloaded, 'conv_2', () => 5);
    await expect.poll(() => after.messages[0]?.state).toBe('accepted');
    expect(seen).toEqual([draft.clientMessageId, draft.clientMessageId]);
    expect(storage.getItem('hamnivo:wid_test:outbox:conv_2')).toBeNull();
    expect(storage.getItem('hamnivo:wid_test:outboxes')).toBeNull();
    after.dispose();
  });

  it('forgets unsent messages when the visitor is signed out, even after a reload', async () => {
    const storage = new MemoryStorage();
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.post(`${API}/v1/widget/conversations/:id/messages`, () => HttpResponse.error()),
      http.post(`${API}/v1/widget/sessions/reset`, () => new HttpResponse(null, { status: 204 })),
    );
    const first = client(storage);
    await first.connect();
    const box = new Outbox(first, 'conv_3', () => 60_000);
    box.enqueue('my address is 12 Garden Road');
    await expect.poll(() => storage.getItem('hamnivo:wid_test:outbox:conv_3')).not.toBeNull();
    box.dispose();
    expect(JSON.parse(storage.getItem('hamnivo:wid_test:outboxes') ?? '[]')).toEqual(['conv_3']);

    // A later page load on the same device signs the visitor out.
    const reloaded = client(storage);
    await reloaded.connect();
    await reloaded.reset();
    expect(storage.getItem('hamnivo:wid_test:outbox:conv_3')).toBeNull();
    expect(storage.getItem('hamnivo:wid_test:outboxes')).toBeNull();
    expect(storage.getItem('hamnivo:wid_test:refresh')).toBeNull();
  });
});

describe('event stream', () => {
  const sse = (frames: string[], keepOpen = false) =>
    new HttpResponse(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          if (!keepOpen) controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const event = (seq: number, type = 'message.created') =>
    `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ sequence: seq, type })}\n\n`;

  it('resumes with Last-Event-ID, drops duplicates, renews on auth_expired and reloads on resync', async () => {
    const cursors: (string | null)[] = [];
    let connection = 0;
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.post(`${API}/v1/widget/sessions/refresh`, () => HttpResponse.json(session())),
      http.get(`${API}/v1/widget/conversations/:id/events`, ({ request }) => {
        cursors.push(request.headers.get('last-event-id'));
        connection += 1;
        if (connection === 1) return sse([event(1), event(2)]);
        if (connection === 2)
          return sse([event(2), event(3), `event: control\ndata: {"control":"auth_expired"}\n\n`]);
        if (connection === 3)
          return sse([
            event(4),
            `event: control\ndata: {"control":"resync_required","reason":"cursor_expired"}\n\n`,
          ]);
        return sse([`event: control\ndata: {"control":"heartbeat","at":"now"}\n\n`], true);
      }),
    );
    const c = client();
    await c.connect();
    const received: number[] = [];
    let resyncs = 0;
    const stream = new EventStream(
      c,
      'conv_1',
      { onEvent: (e) => received.push(e.sequence), onResync: () => (resyncs += 1) },
      { after: 0, backoffMs: () => 5 },
    );
    await expect.poll(() => connection).toBeGreaterThanOrEqual(4);
    expect(received).toEqual([1, 2, 3, 4]);
    expect(cursors.slice(0, 4)).toEqual(['0', '2', '3', null]);
    expect(resyncs).toBe(1);
    stream.close();
  });

  it('stops for good when the conversation is not found', async () => {
    let errors = 0;
    server.use(
      http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 })),
      http.get(`${API}/v1/widget/conversations/:id/events`, () => problem(404, 'NOT_FOUND', false)),
    );
    const c = client();
    await c.connect();
    const statuses: string[] = [];
    new EventStream(c, 'conv_x', {
      onEvent: () => undefined,
      onError: () => (errors += 1),
      onStatus: (s) => statuses.push(s),
    });
    await expect.poll(() => errors).toBe(1);
    expect(statuses.at(-1)).toBe('closed');
  });
});
