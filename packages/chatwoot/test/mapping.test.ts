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

  it('reads the snooze time from ISO strings (API) and Unix seconds, and null otherwise', () => {
    const snoozed = { ...api.getConversation, status: 'snoozed' };
    expect(
      toConversation({ ...snoozed, snoozed_until: '2026-09-27T09:18:25.000Z' }).snoozedUntil,
    ).toEqual(new Date('2026-09-27T09:18:25.000Z'));
    expect(toConversation({ ...snoozed, snoozed_until: 1790497105 }).snoozedUntil).toEqual(
      new Date(1790497105 * 1000),
    );
    expect(toConversation({ ...snoozed, snoozed_until: null }).snoozedUntil).toBeNull();
    expect(toConversation(api.getConversation).snoozedUntil).toBeNull();
  });

  it('reads the priority when the payload has one, and leaves it unknown when it does not', () => {
    expect(toConversation({ ...api.getConversation, priority: 'urgent' }).priority).toBe('urgent');
    expect(toConversation({ ...api.getConversation, priority: null }).priority).toBeNull();
    expect(toConversation({ ...api.getConversation, priority: 'someday' }).priority).toBeNull();
    const { priority: _priority, ...without } = api.getConversation as Record<string, unknown>;
    expect('priority' in toConversation(without)).toBe(false);
  });

  it('reads who wrote in and an email subject, and leaves them unknown when absent', () => {
    const api_ = toConversation(api.getConversation);
    expect(api_.contact).toEqual({ name: 'Ayesha', email: null, phone: null });
    expect(api_.subject).toBeNull();
    const email = toConversation({
      ...api.getConversation,
      meta: {
        sender: {
          id: 5,
          name: 'Omar',
          email: 'omar@example.com',
          phone_number: '+971501234567',
          type: 'contact',
        },
        channel: 'Channel::Email',
      },
      additional_attributes: { source: 'email', mail_subject: 'Where is order 1042?' },
    });
    expect(email).toMatchObject({
      contactRef: '5',
      contact: { name: 'Omar', email: 'omar@example.com', phone: '+971501234567' },
      subject: 'Where is order 1042?',
    });
    // Empty strings are no facts.
    expect(
      toConversation({ ...api.getConversation, meta: { sender: { id: 5, name: '', email: '' } } })
        .contact,
    ).toEqual({ name: null, email: null, phone: null });
    const { additional_attributes: _attributes, ...bare } = api.getConversation as Record<
      string,
      unknown
    >;
    const thin = toConversation({ ...bare, meta: {} });
    expect('contact' in thin).toBe(false);
    expect('subject' in thin).toBe(false);
  });
});

describe('attachments and read markers (v4.18.0 shapes)', () => {
  const blob =
    'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBDUT09IiwiZXhwIjpudWxsLCJwdXIiOiJibG9iX2lkIn19--47d3e6d126a3bdaef68c663c4d50515ae858a61e';

  it('takes the file name from the blob URL, since the JSON has none', () => {
    const m = toMessage({
      ...api.createIncomingMessage,
      attachments: [
        {
          id: 4,
          message_id: 1,
          file_type: 'image',
          content_type: 'image/png',
          data_url: `http://127.0.0.1:3000/rails/active_storage/blobs/redirect/${blob}/r%C3%A9sum%C3%A9.png`,
          file_size: 70,
        },
      ],
    });
    expect(m.attachments).toEqual([
      expect.objectContaining({
        ref: '4',
        fileType: 'image',
        name: 'résumé.png',
        mimeType: 'image/png',
        size: 70,
        coordinates: null,
      }),
    ]);
  });

  it('maps shared places and contacts (attachments without files)', () => {
    const m = toMessage({
      ...api.createIncomingMessage,
      attachments: [
        {
          id: 5,
          file_type: 'location',
          coordinates_lat: 25.2048,
          coordinates_long: 55.2708,
          fallback_title: 'Al Fahidi, Dubai',
          data_url: null,
        },
        {
          id: 6,
          file_type: 'contact',
          fallback_title: '+971 4 123 4567',
          meta: { firstName: 'Aisha', lastName: 'Khan' },
          data_url: null,
        },
      ],
    });
    expect(m.attachments[0]).toMatchObject({
      fileType: 'location',
      coordinates: { latitude: 25.2048, longitude: 55.2708 },
      fallbackTitle: 'Al Fahidi, Dubai',
      name: null,
    });
    expect(m.attachments[1]).toMatchObject({
      fileType: 'contact',
      coordinates: null,
      fallbackTitle: '+971 4 123 4567',
      meta: { firstName: 'Aisha', lastName: 'Khan' },
    });
  });

  it('reads when staff last saw the conversation (0 means never)', () => {
    expect(
      toConversation({ ...api.getConversation, agent_last_seen_at: 1790515970 }).staffLastSeenAt,
    ).toEqual(new Date(1790515970 * 1000));
    expect(
      toConversation({ ...api.getConversation, agent_last_seen_at: 0 }).staffLastSeenAt,
    ).toBeNull();
  });
});
