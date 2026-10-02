import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HamnivoWebhookError,
  MemoryReplayStore,
  signWebhook,
  verifyWebhook,
  type WebhookErrorCode,
} from '../src/index.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';
const NOW = new Date('2026-10-02T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);
const body = JSON.stringify({
  id: 'evt_01k6a3p0a1b2c3d4e5f6g7h8j9',
  type: 'conversation.created',
  timestamp: '2026-10-02T11:59:58.000Z',
  schemaVersion: '1.0',
  tenantId: 'tnt_01k6a3p0a1b2c3d4e5f6g7h8j9',
  data: { conversationId: 'conv_01k6a3p0a1b2c3d4e5f6g7h8j9' },
});
const id = 'evt_01k6a3p0a1b2c3d4e5f6g7h8j9';

/** How the gateway signs (apps/gateway/src/developer/webhooks/signing.ts), with node:crypto. */
function gatewaySignature(secret: string, msgId: string, timestamp: number, payload: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${msgId}.${timestamp}.${payload}`).digest('base64')}`;
}

const headers = (signature: string, timestamp = ts, msgId = id) => ({
  'webhook-id': msgId,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': signature,
});

async function failure(promise: Promise<unknown>): Promise<WebhookErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HamnivoWebhookError) return error.code;
    throw error;
  }
  throw new Error('expected the webhook to be refused');
}

describe('verifyWebhook', () => {
  // Vectors published with the Standard Webhooks reference libraries (JavaScript, MIT; Rust,
  // Apache-2.0): https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries
  it('signs like the Standard Webhooks reference libraries', async () => {
    expect(
      await signWebhook(SECRET, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    expect(
      await signWebhook(
        OTHER,
        'msg_27UH4WbU6Z5A5EzD8u03UvzRbpk',
        1649367553,
        '{"email":"test@example.com","username":"test_user"}',
      ),
    ).toBe('v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=');
  });

  it('accepts what the gateway signs, as text or bytes, with any header style', async () => {
    const signature = gatewaySignature(SECRET, id, ts, body);
    const event = await verifyWebhook(body, headers(signature), { secret: SECRET, now: () => NOW });
    expect(event).toMatchObject({ id, type: 'conversation.created' });
    await expect(
      verifyWebhook(new TextEncoder().encode(body), new Headers(headers(signature)), {
        secret: SECRET.replace('whsec_', ''),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ id });
    await expect(
      verifyWebhook(
        body,
        { 'Webhook-Id': [id], 'Webhook-Timestamp': String(ts), 'Webhook-Signature': signature },
        {
          secret: SECRET,
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({ id });
  });

  it('accepts either secret during a rotation and ignores other signature versions', async () => {
    const both = `v2,${'A'.repeat(43)}= ${gatewaySignature(OTHER, id, ts, body)} ${gatewaySignature(SECRET, id, ts, body)}`;
    await expect(
      verifyWebhook(body, headers(both), { secret: SECRET, now: () => NOW }),
    ).resolves.toMatchObject({ id });
    await expect(
      verifyWebhook(body, headers(gatewaySignature(OTHER, id, ts, body)), {
        secret: [SECRET, OTHER],
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ id });
  });

  it('refuses a changed body, id or timestamp, and a wrong secret', async () => {
    const signature = gatewaySignature(SECRET, id, ts, body);
    const options = { secret: SECRET, now: () => NOW };
    expect(await failure(verifyWebhook(`${body} `, headers(signature), options))).toBe(
      'invalid_signature',
    );
    expect(await failure(verifyWebhook(body, headers(signature, ts, 'evt_other'), options))).toBe(
      'invalid_signature',
    );
    expect(await failure(verifyWebhook(body, headers(signature, ts + 1), options))).toBe(
      'invalid_signature',
    );
    expect(
      await failure(verifyWebhook(body, headers(signature), { secret: OTHER, now: () => NOW })),
    ).toBe('invalid_signature');
    expect(await failure(verifyWebhook(body, headers('v1,'), options))).toBe('invalid_signature');
    expect(await failure(verifyWebhook(body, headers(signature.slice(0, 12)), options))).toBe(
      'invalid_signature',
    );
  });

  it('refuses requests outside the timestamp tolerance', async () => {
    const options = { secret: SECRET, now: () => NOW };
    const old = ts - 301;
    const future = ts + 301;
    expect(
      await failure(
        verifyWebhook(body, headers(gatewaySignature(SECRET, id, old, body), old), options),
      ),
    ).toBe('timestamp_out_of_range');
    expect(
      await failure(
        verifyWebhook(body, headers(gatewaySignature(SECRET, id, future, body), future), options),
      ),
    ).toBe('timestamp_out_of_range');
    const edge = ts - 300;
    await expect(
      verifyWebhook(body, headers(gatewaySignature(SECRET, id, edge, body), edge), options),
    ).resolves.toMatchObject({ id });
    await expect(
      verifyWebhook(body, headers(gatewaySignature(SECRET, id, old, body), old), {
        ...options,
        toleranceSeconds: 600,
      }),
    ).resolves.toMatchObject({ id });
    expect(await failure(verifyWebhook(body, headers('v1,x', Number.NaN), options))).toBe(
      'invalid_timestamp',
    );
  });

  it('requires all three headers', async () => {
    const signature = gatewaySignature(SECRET, id, ts, body);
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const) {
      const partial: Record<string, string> = headers(signature);
      delete partial[name];
      expect(await failure(verifyWebhook(body, partial, { secret: SECRET, now: () => NOW }))).toBe(
        'missing_header',
      );
    }
  });

  it('refuses a replay of an accepted request, and processes it again after a release', async () => {
    let clock = NOW.getTime();
    const store = new MemoryReplayStore({ now: () => clock });
    const signature = gatewaySignature(SECRET, id, ts, body);
    const options = { secret: SECRET, now: () => new Date(clock), replayStore: store };
    await expect(verifyWebhook(body, headers(signature), options)).resolves.toMatchObject({ id });
    expect(await failure(verifyWebhook(body, headers(signature), options))).toBe('duplicate');
    store.release(id);
    await expect(verifyWebhook(body, headers(signature), options)).resolves.toMatchObject({ id });
    // Once the request is past the tolerance it fails on its timestamp, and the id is forgotten.
    clock += 601_000;
    expect(store.claim(id, 600)).toBe(true);
  });

  it('refuses a body that is not a JSON object', async () => {
    const text = 'not json';
    expect(
      await failure(
        verifyWebhook(text, headers(gatewaySignature(SECRET, id, ts, text)), {
          secret: SECRET,
          now: () => NOW,
        }),
      ),
    ).toBe('invalid_payload');
  });
});
