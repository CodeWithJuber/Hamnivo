import { HamnivoClient, MemoryStorage, Outbox } from '@hamnivo/client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConversationStream, useHamnivoClient, useOutbox } from '../src/client.js';

/**
 * The hooks on @hamnivo/client, in a real React, against a stand-in for the Hamnivo API: a fetch
 * that answers the few calls the SDK makes. The SDK itself is tested in packages/client.
 */
const API = 'https://api.test';
const WIDGET = 'wid_test';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, code: string, retryable: boolean) =>
  new Response(JSON.stringify({ status, code, retryable, title: code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

let counter = 0;
const session = () => {
  counter += 1;
  return {
    accessToken: `access-${counter}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `ses_x.refresh-${counter}`,
    principal: { id: `cus_${counter}`, verified: false, displayName: null },
    config: {},
    conversations: [],
  };
};

/** An event stream that stays open, so a test can send events when it wants to. */
function openStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (seq: number) =>
      controller?.enqueue(
        encoder.encode(
          `id: ${seq}\nevent: message.created\ndata: ${JSON.stringify({ sequence: seq, type: 'message.created' })}\n\n`,
        ),
      ),
  };
}

function fakeApi(answer: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      headers,
      signal: init?.signal,
    };
    calls.push(call);
    const custom = answer(call);
    if (custom) return custom;
    if (call.path === '/v1/widget/sessions') return json(session(), 201);
    if (call.path === '/v1/widget/sessions/reset') return new Response(null, { status: 204 });
    if (/\/messages$/.test(call.path) && call.method === 'POST') {
      return json({
        status: 'accepted',
        message: { id: 'msg_1', sequence: 1, parts: call.body.parts },
      });
    }
    return problem(404, 'NOT_FOUND', false);
  });
  const of = (path: string) => calls.filter((call) => call.path === path);
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch, of };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useHamnivoClient', () => {
  const options = (fetch: typeof globalThis.fetch, extra = {}) => ({
    apiBase: API,
    widgetId: WIDGET,
    storage: new MemoryStorage(),
    fetch,
    ...extra,
  });

  it('opens the visitor session, as the page it runs on', async () => {
    const api = fakeApi();
    const stable = options(api.fetch);
    const { result } = renderHook(() => useHamnivoClient(stable));
    expect(result.current.status).toBe('connecting');
    expect(result.current.session).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session?.principal.verified).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.client).toBeInstanceOf(HamnivoClient);
    expect(api.of('/v1/widget/sessions')).toHaveLength(1);
    expect(api.of('/v1/widget/sessions')[0]?.body).toMatchObject({
      widgetId: WIDGET,
      hostOrigin: window.location.origin,
    });
  });

  it('sends the origin and the language it was given', async () => {
    const api = fakeApi();
    const stable = options(api.fetch, { hostOrigin: 'https://shop.test', locale: 'ur' });
    const { result } = renderHook(() => useHamnivoClient(stable));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.of('/v1/widget/sessions')[0]?.body).toMatchObject({
      hostOrigin: 'https://shop.test',
      locale: 'ur',
    });
  });

  it('opens one session even when React runs the effects twice', async () => {
    const api = fakeApi();
    const stable = options(api.fetch);
    const { result } = renderHook(() => useHamnivoClient(stable), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.of('/v1/widget/sessions')).toHaveLength(1);
  });

  it('keeps the same client from one render to the next, and makes a new one for another widget', async () => {
    const api = fakeApi();
    const stable = options(api.fetch);
    const { result, rerender } = renderHook((props) => useHamnivoClient(props), {
      initialProps: stable,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const first = result.current.client;
    rerender({ ...stable });
    expect(result.current.client).toBe(first);
    rerender({ ...stable, widgetId: 'wid_other' });
    expect(result.current.client).not.toBe(first);
    expect(result.current.status).toBe('connecting');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.of('/v1/widget/sessions')).toHaveLength(2);
  });

  it('reports the error when the session cannot be opened, and tries again on retry', async () => {
    let fail = true;
    const api = fakeApi((call) =>
      call.path === '/v1/widget/sessions' && fail
        ? problem(403, 'ORIGIN_NOT_ALLOWED', false)
        : undefined,
    );
    const stable = options(api.fetch);
    const { result } = renderHook(() => useHamnivoClient(stable));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED', status: 403 });
    expect(result.current.session).toBeNull();

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.error).toBeNull();
    expect(api.of('/v1/widget/sessions')).toHaveLength(2);
  });

  it('shows the session as it changes, for example after a sign-out', async () => {
    const api = fakeApi();
    const stable = options(api.fetch);
    const { result } = renderHook(() => useHamnivoClient(stable));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => {
      await result.current.client.reset();
    });
    expect(result.current.session).toBeNull();
    expect(result.current.status).toBe('ready');
  });
});

describe('useOutbox', () => {
  function client(api = fakeApi(), storage = new MemoryStorage()) {
    return {
      api,
      storage,
      client: new HamnivoClient({ apiBase: API, widgetId: WIDGET, storage, fetch: api.fetch }),
    };
  }
  const posts = (api: ReturnType<typeof fakeApi>) =>
    api.calls.filter((call) => /\/messages$/.test(call.path) && call.method === 'POST');

  it('sends a message once and shows it queued, then accepted', async () => {
    const { client: sdk, api } = client();
    const { result } = renderHook(() => useOutbox(sdk, 'conv_1'));
    let sent: ReturnType<typeof result.current.send> | undefined;
    act(() => {
      sent = result.current.send('Where is my order?');
    });
    expect(result.current.messages.map((m) => [m.text, m.state])).toEqual([
      ['Where is my order?', 'queued'],
    ]);
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('accepted'));
    expect(result.current.messages[0]?.message).toMatchObject({ id: 'msg_1' });
    expect(posts(api)).toHaveLength(1);
    expect(posts(api)[0]?.body).toMatchObject({
      clientMessageId: sent?.clientMessageId,
      parts: [{ type: 'text', text: 'Where is my order?' }],
    });
    act(() => result.current.settle(sent?.clientMessageId ?? ''));
    expect(result.current.messages).toEqual([]);
  });

  it('keeps a message that failed, and sends it again with the same id', async () => {
    let refuse = true;
    const api = fakeApi((call) =>
      /\/messages$/.test(call.path) && refuse ? problem(422, 'INVALID', false) : undefined,
    );
    const { client: sdk } = client(api);
    const { result } = renderHook(() => useOutbox(sdk, 'conv_1'));
    let id = '';
    act(() => {
      id = result.current.send('Hello').clientMessageId;
    });
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('failed'));
    expect(result.current.messages[0]?.errorCode).toBe('INVALID');

    refuse = false;
    act(() => result.current.retry(id));
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('accepted'));
    expect(posts(api).map((call) => call.body.clientMessageId)).toEqual([id, id]);
  });

  it('lets a failed message be taken back, for example to edit it', async () => {
    const api = fakeApi((call) =>
      /\/messages$/.test(call.path) ? problem(422, 'INVALID', false) : undefined,
    );
    const { client: sdk } = client(api);
    const { result } = renderHook(() => useOutbox(sdk, 'conv_1'));
    let id = '';
    act(() => {
      id = result.current.send('Typo').clientMessageId;
    });
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('failed'));
    let taken: ReturnType<typeof result.current.remove> = null;
    act(() => {
      taken = result.current.remove(id);
    });
    expect(taken).toMatchObject({ text: 'Typo' });
    expect(result.current.messages).toEqual([]);
  });

  it('keeps what was typed across a reload, until it is accepted', async () => {
    const storage = new MemoryStorage();
    const down = fakeApi((call) =>
      /\/messages$/.test(call.path) ? problem(503, 'UNAVAILABLE', true) : undefined,
    );
    const first = client(down, storage);
    const view = renderHook(() => useOutbox(first.client, 'conv_1'));
    act(() => {
      view.result.current.send('Still here?');
    });
    await waitFor(() => expect(posts(down).length).toBeGreaterThan(0));
    view.unmount();

    const up = fakeApi();
    const second = client(up, storage);
    const again = renderHook(() => useOutbox(second.client, 'conv_1'));
    expect(again.result.current.messages.map((m) => m.text)).toEqual(['Still here?']);
    await waitFor(() => expect(again.result.current.messages[0]?.state).toBe('accepted'));
  });

  it('says there is no conversation to send to, and shows nothing, until there is one', () => {
    const { client: sdk } = client();
    const { result, rerender } = renderHook(({ id }) => useOutbox(sdk, id), {
      initialProps: { id: null as string | null },
    });
    expect(result.current.messages).toEqual([]);
    expect(() => result.current.send('Hi')).toThrow('There is no conversation to send to yet.');
    rerender({ id: 'conv_1' });
    expect(() => act(() => void result.current.send('Hi'))).not.toThrow();
  });

  it('follows the conversation it is given, and disposes the outbox it leaves', async () => {
    const dispose = vi.spyOn(Outbox.prototype, 'dispose');
    const api = fakeApi((call) =>
      /\/messages$/.test(call.path) ? problem(422, 'INVALID', false) : undefined,
    );
    const { client: sdk } = client(api);
    const { result, rerender, unmount } = renderHook(({ id }) => useOutbox(sdk, id), {
      initialProps: { id: 'conv_1' },
    });
    act(() => void result.current.send('One'));
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('failed'));
    rerender({ id: 'conv_2' });
    expect(result.current.messages).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps the same functions from one render to the next', () => {
    const { client: sdk } = client();
    const { result, rerender } = renderHook(() => useOutbox(sdk, 'conv_1'));
    const before = result.current;
    rerender();
    for (const name of ['send', 'retry', 'remove', 'settle', 'flush'] as const) {
      expect(result.current[name], name).toBe(before[name]);
    }
  });
});

describe('useConversationStream', () => {
  const sdk = (api: ReturnType<typeof fakeApi>) =>
    new HamnivoClient({
      apiBase: API,
      widgetId: WIDGET,
      storage: new MemoryStorage(),
      fetch: api.fetch,
    });
  const events = (api: ReturnType<typeof fakeApi>) =>
    api.calls.filter((call) => call.path === '/v1/widget/conversations/conv_1/events');

  function streaming() {
    const stream = openStream();
    const api = fakeApi((call) =>
      call.path === '/v1/widget/conversations/conv_1/events' ? stream.response : undefined,
    );
    return { api, ...stream };
  }

  it('hands over the events in order, once each, and reports the connection', async () => {
    const { api, push } = streaming();
    const client = sdk(api);
    const received: number[] = [];
    const { result } = renderHook(() =>
      useConversationStream(client, 'conv_1', {
        onEvent: (event) => received.push(event.sequence),
      }),
    );
    expect(result.current.status).toBe('connecting');
    await waitFor(() => expect(result.current.status).toBe('open'));
    push(1);
    push(2);
    push(2);
    await waitFor(() => expect(received).toEqual([1, 2]));
  });

  it('calls the latest handlers without starting the stream again', async () => {
    const { api, push } = streaming();
    const client = sdk(api);
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onEvent }) => useConversationStream(client, 'conv_1', { onEvent }),
      { initialProps: { onEvent: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('open'));
    rerender({ onEvent: second });
    push(1);
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
    expect(events(api)).toHaveLength(1);
  });

  it('resumes after the last sequence it is told about', async () => {
    const { api } = streaming();
    const client = sdk(api);
    renderHook(() =>
      useConversationStream(client, 'conv_1', { onEvent: () => undefined }, { after: 7 }),
    );
    await waitFor(() => expect(events(api)).toHaveLength(1));
    expect(events(api)[0]?.headers['last-event-id']).toBe('7');
  });

  it('stops when the component goes, and when the conversation changes', async () => {
    const { api } = streaming();
    const client = sdk(api);
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useConversationStream(client, id, { onEvent: () => undefined }),
      { initialProps: { id: 'conv_1' as string | null } },
    );
    await waitFor(() => expect(result.current.status).toBe('open'));
    const signal = events(api)[0]?.signal;
    expect(signal?.aborted).toBe(false);
    rerender({ id: null });
    expect(signal?.aborted).toBe(true);
    expect(result.current.status).toBe('closed');
    unmount();
  });

  it('is closed until there is a conversation', () => {
    const { api } = streaming();
    const client = sdk(api);
    const { result } = renderHook(() =>
      useConversationStream(client, null, { onEvent: () => undefined }),
    );
    expect(result.current.status).toBe('closed');
    expect(events(api)).toHaveLength(0);
  });

  it('opens one stream even when React runs the effects twice, and passes on a failure that ends it', async () => {
    const api = fakeApi((call) =>
      call.path === '/v1/widget/conversations/conv_1/events'
        ? problem(404, 'NOT_FOUND', false)
        : undefined,
    );
    const client = sdk(api);
    const onError = vi.fn();
    const { result } = renderHook(
      () => useConversationStream(client, 'conv_1', { onEvent: () => undefined, onError }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'NOT_FOUND' });
    await waitFor(() => expect(result.current.status).toBe('closed'));
  });
});
