import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  parseChatwootEvent,
  redactChatwootPayload,
  verifyChatwootSignature,
} from '../src/webhooks.js';
import { webhooks } from './fixtures.js';

const secret = 'test-secret';
const sign = (ts: string, body: string, key = secret) =>
  `sha256=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;

describe('verifyChatwootSignature', () => {
  const body = JSON.stringify({ event: 'message_created', id: 1 });
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);

  it('accepts a fresh, correctly signed body', () => {
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: ts,
        signature: sign(ts, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: true });
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: ts,
        signature: sign(ts, body),
        rawBody: Buffer.from(body),
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects missing, stale, tampered and foreign-secret deliveries', () => {
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: undefined,
        signature: sign(ts, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      verifyChatwootSignature({ secret, timestamp: ts, signature: 'abc', rawBody: body, now }),
    ).toEqual({ ok: false, reason: 'missing' });
    const old = String(now / 1000 - 301);
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: old,
        signature: sign(old, body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: ts,
        signature: sign(ts, body),
        rawBody: `${body} `,
        now,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: ts,
        signature: sign(ts, body, 'other'),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(
      verifyChatwootSignature({
        secret,
        timestamp: ts,
        signature: 'sha256=zz',
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('parseChatwootEvent (real v4.18.0 deliveries)', () => {
  it('normalizes every captured event', () => {
    const types = webhooks.map((w) => parseChatwootEvent(w.payload).type);
    expect(types).not.toContain('unknown');
    const created = parseChatwootEvent(
      webhooks.find((w) => w.event === 'conversation_created')?.payload,
    );
    expect(created).toMatchObject({
      type: 'conversation.created',
      accountRef: '1',
      conversation: { ref: '1', status: 'pending' },
    });
    const contact = parseChatwootEvent(
      webhooks.find((w) => w.event === 'contact_created')?.payload,
    );
    expect(contact).toEqual({
      type: 'contact.created',
      accountRef: '1',
      contactRef: '1',
      identifier: 'hv:brand:customer-1',
    });
    const message = parseChatwootEvent(
      webhooks.find((w) => w.event === 'message_created')?.payload,
    );
    expect(message).toMatchObject({ type: 'message.created', message: { conversationRef: '1' } });
  });

  it('maps typing and keeps unknown events instead of dropping them', () => {
    expect(
      parseChatwootEvent({
        event: 'conversation_typing_on',
        account: { id: 4 },
        conversation: { id: 9 },
        user: { id: 2 },
      }),
    ).toEqual({
      type: 'conversation.typing',
      accountRef: '4',
      conversationRef: '9',
      on: true,
      userRef: '2',
    });
    expect(parseChatwootEvent({ event: 'webwidget_triggered', account: { id: 4 } })).toEqual({
      type: 'unknown',
      accountRef: '4',
      name: 'webwidget_triggered',
    });
    expect(parseChatwootEvent(null)).toEqual({
      type: 'unknown',
      accountRef: null,
      name: 'missing',
    });
  });
});

describe('dedupeKey', () => {
  it('collapses the account, inbox and bot copies of one change', () => {
    const keysFor = (event: string, id?: number) =>
      new Set(
        webhooks
          .filter((w) => w.event === event && (id === undefined || w.payload.id === id))
          .map((w) => dedupeKey(parseChatwootEvent(w.payload))),
      );
    for (const id of [1, 2, 3]) expect(keysFor('message_created', id).size).toBe(1);
    // The bot copy carries updated_at with more float digits than the account and inbox copies.
    const floats = new Set(
      webhooks.filter((w) => w.event === 'conversation_updated').map((w) => w.payload.updated_at),
    );
    expect(floats.size).toBe(2);
    expect(keysFor('conversation_updated').size).toBe(1);
    expect(keysFor('conversation_created').size).toBe(1);
  });

  it('separates different content and different state', () => {
    const base =
      webhooks.find((w) => w.event === 'message_created' && w.payload.id === 1)?.payload ?? {};
    const edited = { ...base, content: 'edited' };
    expect(dedupeKey(parseChatwootEvent(base))).not.toBe(dedupeKey(parseChatwootEvent(edited)));
    const conv = webhooks.find((w) => w.event === 'conversation_updated')?.payload ?? {};
    expect(dedupeKey(parseChatwootEvent(conv))).not.toBe(
      dedupeKey(parseChatwootEvent({ ...conv, status: 'open' })),
    );
    expect(dedupeKey(parseChatwootEvent({ event: 'x' }), 'd-1')).toBe('delivery:d-1:unknown');
  });
});

describe('redactChatwootPayload', () => {
  it('drops contact-inbox source ids and tokens but keeps Hamnivo message keys', () => {
    const payload = {
      source_id: 'hv1:m:1',
      pubsub_token: 'p',
      conversation: {
        contact_inbox: { id: 1, source_id: 'secret-source', hmac_verified: false },
        messages: [
          { source_id: 'hv1:p:2', conversation: { contact_inbox: { source_id: 'secret-source' } } },
        ],
      },
      sender: { access_token: 't' },
    };
    const redacted = redactChatwootPayload(payload);
    expect(JSON.stringify(redacted)).not.toContain('secret-source');
    expect(redacted).toEqual({
      source_id: 'hv1:m:1',
      conversation: {
        contact_inbox: { id: 1, hmac_verified: false },
        messages: [{ source_id: 'hv1:p:2', conversation: { contact_inbox: {} } }],
      },
      sender: {},
    });
  });
});
