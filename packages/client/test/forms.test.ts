import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HamnivoClient, MemoryStorage } from '../src/index.js';

/**
 * Forms, consent, tickets and the direct chat link (W11, W15, W26–W28, H19): the calls the widget
 * makes for them.
 */

const API = 'https://api.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let counter = 0;
function session(consent = { required: true, given: false, noticeVersion: 3, text: {} }) {
  counter += 1;
  return {
    accessToken: `access-${counter}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `ses_x.refresh-${counter}`,
    principal: { id: 'cus_1', verified: false, displayName: null },
    config: { consent },
    conversations: [],
  };
}

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'conv_1',
  status: 'open',
  responder: 'ai',
  createdAt: '2026-10-09T10:00:00Z',
  updatedAt: '2026-10-09T10:00:00Z',
  unreadCount: 0,
  lastMessagePreview: null,
  latestSequence: 1,
  ticket: null,
  ...overrides,
});

const sessions = (bodies: Record<string, unknown>[] = []) =>
  http.post(`${API}/v1/widget/sessions`, async ({ request }) => {
    bodies.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json(session(), { status: 201 });
  });

function client(options: { direct?: boolean } = {}) {
  return new HamnivoClient({
    apiBase: API,
    widgetId: 'wid_test',
    hostOrigin: 'https://shop.test',
    storage: new MemoryStorage(),
    ...options,
  });
}

describe('the direct chat link (W28)', () => {
  it('opens the session as direct and sends no host origin', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(sessions(bodies));
    await client({ direct: true }).connect();
    await client().connect();
    expect(bodies[0]).toMatchObject({ widgetId: 'wid_test', direct: true });
    expect(bodies[0]).not.toHaveProperty('hostOrigin');
    expect(bodies[1]).toMatchObject({ hostOrigin: 'https://shop.test' });
    expect(bodies[1]).not.toHaveProperty('direct');
  });
});

describe('starting with the pre-chat answers (W26)', () => {
  it('sends the answers, the first message and the page with the start', async () => {
    const bodies: unknown[] = [];
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(conversation(), { status: 201 });
      }),
    );
    const c = client();
    await c.connect();
    const started = await c.startConversation({
      firstMessage: 'Where is my order?',
      clientMessageId: 'b8f2f8e0-0000-4000-8000-000000000001',
      prechat: { name: 'Amina', team: 'billing' },
      context: { url: 'https://shop.test/orders' },
    });
    expect(started).toMatchObject({ id: 'conv_1', ticket: null });
    expect(bodies).toEqual([
      {
        firstMessage: 'Where is my order?',
        clientMessageId: 'b8f2f8e0-0000-4000-8000-000000000001',
        prechat: { name: 'Amina', team: 'billing' },
        context: { url: 'https://shop.test/orders' },
      },
    ]);
  });

  it('turns a refusal into an error that names the fields', async () => {
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations`, () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'VALIDATION_FAILED',
            retryable: false,
            fields: [{ path: 'prechat.email', message: 'Invalid email' }],
          },
          { status: 422 },
        ),
      ),
    );
    const c = client();
    await c.connect();
    await expect(c.startConversation({ prechat: { email: 'nope' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      problem: { fields: [{ path: 'prechat.email' }] },
    });
  });
});

describe('consent before chatting (W27)', () => {
  it('records the version agreed to, and the session then says so', async () => {
    const bodies: unknown[] = [];
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/consent`, async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const c = client();
    await c.connect();
    const heard: boolean[] = [];
    c.onSession((s) => heard.push(Boolean(s?.config.consent.given)));
    expect(await c.giveConsent(3)).toBeUndefined();
    expect(bodies).toEqual([{ noticeVersion: 3 }]);
    expect(c.current?.config.consent).toMatchObject({ given: true, noticeVersion: 3 });
    expect(heard).toEqual([true]);
  });

  it('changes nothing on this device when the gateway refuses', async () => {
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/consent`, () =>
        HttpResponse.json(
          { status: 422, code: 'VALIDATION_FAILED', retryable: false },
          { status: 422 },
        ),
      ),
    );
    const c = client();
    await c.connect();
    await expect(c.giveConsent(2)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(c.current?.config.consent.given).toBe(false);
  });
});

describe('leaving a message while nobody can answer (W11, H19)', () => {
  it('sends the answers with the request id as its idempotency key, the same on a retry', async () => {
    const seen: { key: string | null; body: unknown }[] = [];
    let unavailable = 1;
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/offline-messages`, async ({ request }) => {
        seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        if (unavailable-- > 0) {
          return HttpResponse.json(
            { status: 503, code: 'AUTHORITY_UNAVAILABLE', retryable: true },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          {
            conversation: conversation({ ticket: { reference: '#1042', state: 'open' } }),
            reference: '#1042',
            email: 'a•••@example.com',
            confirmationSent: true,
          },
          { status: 201 },
        );
      }),
    );
    const c = client();
    await c.connect();
    const id = 'b8f2f8e0-0000-4000-8000-000000000002';
    const answers = { name: 'Amina', email: 'amina@example.com', question: 'Refund?' };
    await expect(c.sendOfflineMessage({ answers }, id)).rejects.toMatchObject({
      retryable: true,
    });
    const sent = await c.sendOfflineMessage({ answers }, id);
    expect(sent).toMatchObject({ reference: '#1042', confirmationSent: true });
    expect(sent.conversation.ticket).toEqual({ reference: '#1042', state: 'open' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toEqual({ key: id, body: { clientRequestId: id, answers } });
  });
});

describe('closed conversations (W15, CSAT)', () => {
  it('reopens a conversation and rates one, with the session', async () => {
    const calls: string[] = [];
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/reopen`, ({ params, request }) => {
        calls.push(`reopen ${params.id} ${request.headers.get('authorization')?.slice(0, 13)}`);
        return HttpResponse.json(conversation({ id: params.id, status: 'open' }));
      }),
      http.post(`${API}/v1/widget/conversations/:id/feedback`, async ({ params, request }) => {
        calls.push(`feedback ${params.id} ${JSON.stringify(await request.json())}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const c = client();
    await c.connect();
    expect(await c.reopen('conv_9')).toMatchObject({ id: 'conv_9', status: 'open' });
    expect(await c.feedback('conv_9', { rating: 5, comment: 'Kind' })).toBeUndefined();
    await c.feedback('conv_9', { rating: 2 });
    expect(calls).toEqual([
      'reopen conv_9 Bearer access',
      'feedback conv_9 {"rating":5,"comment":"Kind"}',
      'feedback conv_9 {"rating":2}',
    ]);
  });
});
