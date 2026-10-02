import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HamnivoClient, MemoryStorage, Outbox } from '../src/index.js';

const API = 'https://api.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let counter = 0;
function session() {
  counter += 1;
  return {
    accessToken: `access-${counter}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `ses_x.refresh-${counter}`,
    principal: { id: 'cus_1', verified: false, displayName: null },
    config: {},
    conversations: [],
  };
}

const sessions = () =>
  http.post(`${API}/v1/widget/sessions`, () => HttpResponse.json(session(), { status: 201 }));

function client(storage = new MemoryStorage()) {
  return new HamnivoClient({ apiBase: API, widgetId: 'wid_test', storage });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('files (W09)', () => {
  it('uploads a file’s own bytes and downloads with the session, renewing once', async () => {
    const seen: Record<string, unknown>[] = [];
    let expired = true;
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/sessions/refresh`, () => HttpResponse.json(session())),
      http.post(`${API}/v1/widget/conversations/:id/uploads`, async ({ request, params }) => {
        const url = new URL(request.url);
        seen.push({
          conversation: params.id,
          name: url.searchParams.get('name'),
          type: request.headers.get('content-type'),
          auth: request.headers.get('authorization'),
          bytes: [...new Uint8Array(await request.arrayBuffer())],
        });
        return HttpResponse.json(
          {
            type: 'attachment',
            uploadId: 'upl_1',
            name: 'photo.png',
            mimeType: 'image/png',
            sizeBytes: PNG.length,
            status: 'available',
          },
          { status: 201 },
        );
      }),
      http.get(`${API}/v1/widget/conversations/:id/attachments/:file`, ({ request }) => {
        if (expired) {
          expired = false;
          return HttpResponse.json({ code: 'SESSION_EXPIRED' }, { status: 401 });
        }
        expect(request.headers.get('authorization')).toMatch(/^Bearer access-/);
        return new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } });
      }),
    );
    const c = client();
    await c.connect();
    const uploaded = await c.uploadAttachment('conv_1', new Blob([PNG]), 'my photo.png');
    expect(uploaded).toMatchObject({ uploadId: 'upl_1', status: 'available' });
    expect(seen).toEqual([
      {
        conversation: 'conv_1',
        name: 'my photo.png',
        type: 'application/octet-stream',
        auth: expect.stringMatching(/^Bearer access-/),
        bytes: [...PNG],
      },
    ]);
    const blob = await c.downloadAttachment('conv_1', 'upl_2');
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
  });

  it('reports why a file was refused', async () => {
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/uploads`, () =>
        HttpResponse.json(
          { status: 422, code: 'UPLOAD_REJECTED', reason: 'malware_detected', retryable: false },
          { status: 422 },
        ),
      ),
    );
    const c = client();
    await c.connect();
    await expect(c.uploadAttachment('conv_1', PNG, 'x.png')).rejects.toMatchObject({
      status: 422,
      code: 'UPLOAD_REJECTED',
      retryable: false,
      problem: { reason: 'malware_detected' },
    });
  });

  it('sends the words and the files of a message together, the same way on every retry', async () => {
    const bodies: unknown[] = [];
    let unavailable = 1;
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/messages`, async ({ request }) => {
        bodies.push(await request.json());
        if (unavailable-- > 0) {
          return HttpResponse.json(
            { code: 'AUTHORITY_UNAVAILABLE', retryable: true },
            {
              status: 503,
            },
          );
        }
        return HttpResponse.json({ status: 'accepted', message: { id: 'msg_1' } }, { status: 202 });
      }),
    );
    const c = client();
    await c.connect();
    const outbox = new Outbox(c, 'conv_1', { backoffMs: () => 5 });
    const files = [
      { uploadId: 'upl_a', name: 'a.png', mimeType: 'image/png', sizeBytes: 10 },
      { uploadId: 'upl_b', name: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 20 },
    ];
    outbox.enqueue('Here they are', files);
    outbox.enqueue('', [files[0] as (typeof files)[number]]);
    await expect.poll(() => outbox.messages.every((m) => m.state === 'accepted')).toBe(true);
    const [first, retry, filesOnly] = bodies as Array<{ clientMessageId: string; parts: unknown }>;
    expect(first).toEqual(retry);
    expect(first?.parts).toEqual([
      { type: 'text', text: 'Here they are' },
      { type: 'attachment', uploadId: 'upl_a' },
      { type: 'attachment', uploadId: 'upl_b' },
    ]);
    // Files alone need no words.
    expect(filesOnly?.parts).toEqual([{ type: 'attachment', uploadId: 'upl_a' }]);
    outbox.dispose();
  });
});

describe('offline (W11)', () => {
  it('waits while offline without spending attempts, then sends each message once', async () => {
    const seen: string[] = [];
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/messages`, async ({ request }) => {
        seen.push(((await request.json()) as { clientMessageId: string }).clientMessageId);
        return HttpResponse.json({ status: 'accepted', message: { id: 'msg' } }, { status: 202 });
      }),
    );
    const c = client();
    await c.connect();
    let online = false;
    // The browser window, whose "online" event wakes the outbox.
    const browser = new EventTarget();
    Object.assign(globalThis, { window: browser });
    const outbox = new Outbox(c, 'conv_2', { backoffMs: () => 5, online: () => online });
    const one = outbox.enqueue('first');
    const two = outbox.enqueue('second');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([]);
    expect(outbox.messages.map((m) => [m.state, m.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0],
    ]);
    online = true;
    // The browser's "online" event and a "try again" tap at the same moment.
    browser.dispatchEvent(new Event('online'));
    outbox.flush();
    await expect.poll(() => outbox.messages.every((m) => m.state === 'accepted')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([one.clientMessageId, two.clientMessageId]);
    outbox.dispose();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('lets the visitor take back a message that failed, to edit or drop it', async () => {
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/messages`, () =>
        HttpResponse.json(
          { status: 422, code: 'UPLOAD_REJECTED', retryable: false, detail: 'File expired' },
          { status: 422 },
        ),
      ),
    );
    const storage = new MemoryStorage();
    const c = client(storage);
    await c.connect();
    const outbox = new Outbox(c, 'conv_3', { backoffMs: () => 5 });
    const item = outbox.enqueue('with a file', [
      { uploadId: 'upl_old', name: 'a.png', mimeType: 'image/png', sizeBytes: 1 },
    ]);
    await expect.poll(() => outbox.messages[0]?.state).toBe('failed');
    expect(outbox.messages[0]).toMatchObject({
      errorCode: 'UPLOAD_REJECTED',
      error: 'File expired',
    });
    expect(outbox.remove(item.clientMessageId)).toMatchObject({ text: 'with a file' });
    expect(outbox.messages).toEqual([]);
    expect(storage.getItem('hamnivo:wid_test:outbox:conv_3')).toBeNull();
    expect(outbox.remove(item.clientMessageId)).toBeNull();
    outbox.dispose();
  });
});

describe('drafts (W07)', () => {
  it('keeps each person’s drafts across reloads and forgets them all at sign-out', async () => {
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/sessions/reset`, () => new HttpResponse(null, { status: 204 })),
    );
    const storage = new MemoryStorage();
    const first = client(storage);
    first.drafts.set('cus_1:conv_1', 'My order number is');
    first.drafts.set('cus_1:new', 'Hello');
    first.drafts.set('cus_1:new', '   ');
    const reloaded = client(storage);
    expect(reloaded.drafts.get('cus_1:conv_1')).toBe('My order number is');
    expect(reloaded.drafts.get('cus_1:new')).toBe('');
    expect(reloaded.drafts.get('cus_2:conv_1')).toBe('');
    await reloaded.connect();
    await reloaded.reset();
    expect(client(storage).drafts.get('cus_1:conv_1')).toBe('');
    expect(storage.getItem('hamnivo:wid_test:drafts')).toBeNull();
  });
});

describe('messages, help and emails (W05, W17, W22, W23, W25)', () => {
  it('calls each endpoint with the session', async () => {
    const calls: string[] = [];
    const record = async ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.text() : '';
      calls.push(`${request.method} ${url.pathname}${url.search} ${body}`.trim());
      return null;
    };
    server.use(
      sessions(),
      http.post(`${API}/v1/widget/conversations/:id/read`, async (info) => {
        await record(info);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${API}/v1/widget/conversations/:id/messages/:m/delete`, async (info) => {
        await record(info);
        return HttpResponse.json({ messageId: 'msg_1', deletedAt: '2026-10-02T10:00:00Z' });
      }),
      http.post(`${API}/v1/widget/conversations/:id/messages/:m/reactions`, async (info) => {
        await record(info);
        return HttpResponse.json({ status: 'accepted', message: { id: 'msg_r' } }, { status: 202 });
      }),
      http.get(`${API}/v1/widget/help/search`, async (info) => {
        await record(info);
        return HttpResponse.json({ query: 'returns', items: [] });
      }),
      http.get(`${API}/v1/widget/notifications`, async (info) => {
        await record(info);
        return HttpResponse.json({ available: false, reason: 'not_verified' });
      }),
      http.post(`${API}/v1/widget/notifications`, async (info) => {
        await record(info);
        return HttpResponse.json({ available: true, transcript: true });
      }),
    );
    const c = client();
    await c.connect();
    await c.markRead('conv_1', 12);
    expect(await c.deleteMessage('conv_1', 'msg_1')).toMatchObject({ messageId: 'msg_1' });
    await c.react('conv_1', 'msg_2', 'b8f2f8e0-0000-4000-8000-000000000001', '🙏');
    await c.helpSearch('returns & exchanges');
    await c.notifications();
    await c.setNotifications({ transcript: true });
    expect(calls).toEqual([
      'POST /v1/widget/conversations/conv_1/read {"upToSequence":12}',
      'POST /v1/widget/conversations/conv_1/messages/msg_1/delete',
      'POST /v1/widget/conversations/conv_1/messages/msg_2/reactions {"clientMessageId":"b8f2f8e0-0000-4000-8000-000000000001","emoji":"🙏"}',
      'GET /v1/widget/help/search?q=returns+%26+exchanges',
      'GET /v1/widget/notifications',
      'POST /v1/widget/notifications {"transcript":true}',
    ]);
  });
});
