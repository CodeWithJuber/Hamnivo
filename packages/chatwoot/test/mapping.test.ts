import { describe, expect, it } from 'vitest';
import { toConversation, toMessage } from '../src/mapping.js';
import { api, webhooks } from './fixtures.js';

describe('toMessage (real v4.18.0 payloads)', () => {
  it('maps an incoming API message written with a Hamnivo key', () => {
    const m = toMessage(api.createIncomingMessage);
    expect(m).toMatchObject({
      ref: '1',
      conversationRef: '1',
      key: 'hv1:m:probe-1',
      direction: 'incoming',
      private: false,
      text: 'Assalamu alaikum, I need help',
      contentAttributes: { hv: { v: 1 } },
      sender: { kind: 'contact', ref: '1', name: 'Ayesha' },
    });
    expect(m.createdAt.getTime()).toBe(1790468294 * 1000);
  });

  it('attributes bot and staff messages to their real authors', () => {
    expect(toMessage(api.createBotMessage)).toMatchObject({
      direction: 'outgoing',
      key: 'hv1:p:probe-2',
      sender: { kind: 'bot', ref: '1', name: 'Hamnivo AI' },
    });
    expect(toMessage(api.createPrivateNote)).toMatchObject({
      private: true,
      key: 'hv1:n:probe-3',
      sender: { kind: 'user', ref: '2' },
    });
  });

  it('reads webhook messages (string types, ISO times, untyped contact senders)', () => {
    const incoming = webhooks.find((w) => w.event === 'message_created' && w.payload.id === 1);
    const m = toMessage(incoming?.payload, '1');
    expect(m).toMatchObject({ direction: 'incoming', sender: { kind: 'contact', ref: '1' } });
    expect(Number.isNaN(m.createdAt.getTime())).toBe(false);
    const note = webhooks.find((w) => w.event === 'message_created' && w.payload.id === 3);
    expect(toMessage(note?.payload, '1')).toMatchObject({
      private: true,
      sender: { kind: 'user' },
    });
  });

  it('never invents a key for messages written elsewhere', () => {
    expect(toMessage({ ...api.createIncomingMessage, source_id: null }).key).toBeNull();
  });
});

describe('toConversation (real v4.18.0 payloads)', () => {
  it('maps the API conversation owned by the Hamnivo bot', () => {
    const c = toConversation(api.getConversation);
    expect(c).toMatchObject({
      ref: '1',
      inboxRef: '1',
      contactRef: '1',
      status: 'pending',
      owner: { kind: 'bot', botRef: '1' },
      teamRef: null,
      labels: [],
    });
    expect(c.version).toBeCloseTo(1790468294.4489331, 6);
  });

  it('maps conversation webhooks from every source to the same state', () => {
    const updates = webhooks
      .filter((w) => w.event === 'conversation_updated')
      .map((w) => toConversation(w.payload));
    expect(new Set(updates.map((u) => JSON.stringify({ ...u, version: 0 }))).size).toBe(1);
    expect(updates[0]?.owner).toEqual({ kind: 'bot', botRef: '1' });
  });

  it('treats a person as owner when the assignee is a user', () => {
    const payload = {
      ...api.getConversation,
      status: 'open',
      meta: { assignee: { id: 7, name: 'Sara' }, assignee_type: 'User', team: { id: 3 } },
    };
    expect(toConversation(payload)).toMatchObject({
      status: 'open',
      owner: { kind: 'user', userRef: '7' },
      teamRef: '3',
    });
    expect(toConversation({ ...payload, meta: {} }).owner).toEqual({ kind: 'none' });
  });
});
