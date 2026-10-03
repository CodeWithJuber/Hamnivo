import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InboxDetail, inboxKeys } from '../src/lib/inbox';
import {
  type InboxAlert,
  inboxEventHandler,
  parseAlert,
  readEvents,
  TYPING_LINE_MS,
} from '../src/lib/inbox-live';

const TENANT = 'tnt_test';
const CHAT = 'conv_1';

const detail = (extra: Partial<InboxDetail> = {}) =>
  ({ id: CHAT, customerTyping: false, presence: [], ...extra }) as unknown as InboxDetail;

function setup() {
  const client = new QueryClient();
  const alerts: InboxAlert[] = [];
  let expired = 0;
  const handler = inboxEventHandler(client, TENANT, {
    alert: (alert) => alerts.push(alert),
    authExpired: () => {
      expired += 1;
    },
  });
  const chat = [TENANT, ...inboxKeys.conversation(CHAT)];
  client.setQueryData(chat, detail());
  const send = (event: string, payload: unknown) =>
    handler.handle({ event, data: JSON.stringify(payload) });
  return { client, alerts, handler, chat, send, expired: () => expired };
}

describe('events from the inbox stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads the lists, the unread count and the conversations that changed', () => {
    const { client, send } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    send('inbox.changed', { type: 'inbox.changed', conversationIds: [CHAT, 7, 'conv_2'] });
    const keys = invalidate.mock.calls.map(([filter]) => filter?.queryKey);
    expect(keys).toContainEqual([TENANT, ...inboxKeys.lists]);
    expect(keys).toContainEqual([TENANT, ...inboxKeys.unread]);
    expect(keys).toContainEqual([TENANT, ...inboxKeys.conversation(CHAT)]);
    expect(keys).toContainEqual([TENANT, ...inboxKeys.conversation('conv_2')]);
    // Anything that is not an id is ignored.
    expect(keys).toHaveLength(4);
  });

  it('shows who else is in a conversation without reloading it', () => {
    const { client, send, chat } = setup();
    const viewers = [{ staffMemberId: 'staff_2', displayName: 'Rayan', state: 'typing' }];
    send('presence', { type: 'presence', conversationId: CHAT, viewers });
    expect(client.getQueryData<InboxDetail>(chat)?.presence).toEqual(viewers);
    // A conversation that is not open anywhere has nothing to update.
    send('presence', { type: 'presence', conversationId: 'conv_9', viewers });
    expect(client.getQueryData([TENANT, ...inboxKeys.conversation('conv_9')])).toBeUndefined();
  });

  it('shows that the customer is typing, and stops showing it when they stop', () => {
    const { client, send, chat } = setup();
    send('customer_typing', { type: 'customer_typing', conversationId: CHAT, typing: true });
    expect(client.getQueryData<InboxDetail>(chat)?.customerTyping).toBe(true);
    send('customer_typing', { type: 'customer_typing', conversationId: CHAT, typing: false });
    expect(client.getQueryData<InboxDetail>(chat)?.customerTyping).toBe(false);
    // Nothing is left to switch it back off, or on.
    vi.advanceTimersByTime(TYPING_LINE_MS * 2);
    expect(client.getQueryData<InboxDetail>(chat)?.customerTyping).toBe(false);
  });

  it('drops the typing line when "stopped" never arrives, and keeps it while reports continue', () => {
    const { client, send, chat } = setup();
    const typing = () => client.getQueryData<InboxDetail>(chat)?.customerTyping;
    send('customer_typing', { type: 'customer_typing', conversationId: CHAT, typing: true });
    vi.advanceTimersByTime(TYPING_LINE_MS - 1000);
    // The customer is still typing: the gateway says so again, which starts the wait over.
    send('customer_typing', { type: 'customer_typing', conversationId: CHAT, typing: true });
    vi.advanceTimersByTime(TYPING_LINE_MS - 1000);
    expect(typing()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(typing()).toBe(false);
  });

  it('hands alerts on, and ignores anything that is not an alert', () => {
    const { alerts, send } = setup();
    const alert = {
      type: 'alert',
      kind: 'chat_waiting',
      conversationId: CHAT,
      customerName: 'Maya Khan',
      preview: 'Where is my order?',
      at: '2026-10-03T10:00:00.000Z',
    };
    send('alert', alert);
    send('alert', { ...alert, kind: 'unknown' });
    send('alert', { ...alert, customerName: 7 });
    send('alert', { ...alert, preview: undefined });
    send('alert', { ...alert, kind: 'assigned', preview: null });
    expect(alerts.map((a) => [a.kind, a.preview])).toEqual([
      ['chat_waiting', 'Where is my order?'],
      ['assigned', null],
    ]);
  });

  it('asks for a new sign-in when the session ends', () => {
    const { client, send, expired } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    send('control', { control: 'heartbeat' });
    expect(expired()).toBe(0);
    send('control', { control: 'auth_expired' });
    expect(expired()).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me', TENANT] });
  });

  it('does not stumble on text that is not JSON', () => {
    const { handler, alerts } = setup();
    expect(() => handler.handle({ event: 'alert', data: 'not json' })).not.toThrow();
    expect(alerts).toEqual([]);
  });

  it('leaves no timer behind when it is closed', () => {
    const { client, send, chat, handler } = setup();
    send('customer_typing', { type: 'customer_typing', conversationId: CHAT, typing: true });
    handler.dispose();
    vi.advanceTimersByTime(TYPING_LINE_MS * 2);
    expect(client.getQueryData<InboxDetail>(chat)?.customerTyping).toBe(true);
  });
});

describe('parseAlert', () => {
  it('needs every field, in the right type', () => {
    const ok = {
      kind: 'customer_message',
      conversationId: CHAT,
      customerName: 'Maya',
      preview: null,
      at: '2026-10-03T10:00:00.000Z',
    };
    expect(parseAlert(ok)).toMatchObject({ type: 'alert', kind: 'customer_message' });
    for (const field of ['kind', 'conversationId', 'customerName', 'at']) {
      expect(parseAlert({ ...ok, [field]: undefined })).toBeNull();
    }
    expect(parseAlert({ ...ok, preview: 3 })).toBeNull();
  });
});

describe('readEvents', () => {
  it('splits a stream into events, whatever the chunks look like', async () => {
    const text =
      ': stream open\n\n' +
      'event: inbox.changed\ndata: {"conversationIds":["conv_1"]}\n\n' +
      'event: alert\ndata: {"a":\ndata: 1}\n\n' +
      'data: plain\n\n';
    const bytes = new TextEncoder().encode(text);
    // Cut the text at awkward places, including inside a line.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const cut of [
          [0, 7],
          [7, 40],
          [40, 75],
          [75, bytes.length],
        ] as const) {
          controller.enqueue(bytes.slice(cut[0], cut[1]));
        }
        controller.close();
      },
    });
    const events: { event: string; data: string }[] = [];
    let activity = 0;
    await readEvents(
      body,
      (event) => events.push(event),
      () => {
        activity += 1;
      },
    );
    expect(events).toEqual([
      { event: 'inbox.changed', data: '{"conversationIds":["conv_1"]}' },
      { event: 'alert', data: '{"a":\n1}' },
      { event: 'message', data: 'plain' },
    ]);
    expect(activity).toBe(4);
  });
});
