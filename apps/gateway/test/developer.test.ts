import { randomBytes } from 'node:crypto';
import { EgressError, type EgressResponse } from '@hamnivo/adapters/net';
import { ApiKeyPermission, WEBHOOK_EVENT_TYPES, WebhookPayload } from '@hamnivo/contracts';
import { API_KEY_PERMISSIONS } from '@hamnivo/policy';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/app-error.js';
import { planLimitFromDatabase } from '../src/common/plan-limit.js';
import { toProblem } from '../src/common/problem.filter.js';
import { ApiKeyHasher, bearerApiKey, generateApiKey, parseApiKey } from '../src/developer/keys.js';
import {
  judgeError,
  judgeResponse,
  MAX_ATTEMPTS,
  nextAttemptDelay,
  RETRY_DELAYS_MS,
  responseExcerpt,
  shouldDisable,
} from '../src/developer/webhooks/delivery-rules.js';
import { handoffType, holder } from '../src/developer/webhooks/events.js';
import { payloadPreview } from '../src/developer/webhooks/redact.js';
import {
  generateSigningSecret,
  secretBytes,
  sign,
  signatureHeaders,
} from '../src/developer/webhooks/signing.js';

const response = (status: number, headers: Record<string, string> = {}): EgressResponse => ({
  status,
  headers,
  body: Buffer.alloc(0),
  truncated: false,
  durationMs: 12,
  remoteAddress: '93.184.216.34',
  url: 'https://hooks.example.com/hv',
  redirects: 0,
});

describe('Standard Webhooks signatures', () => {
  // Vectors published with the Standard Webhooks reference libraries (JavaScript, MIT; Rust,
  // Apache-2.0): https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries
  it('matches the reference JavaScript vector', () => {
    expect(
      sign(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('matches the reference Rust vector', () => {
    expect(
      sign(
        'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD',
        'msg_27UH4WbU6Z5A5EzD8u03UvzRbpk',
        1649367553,
        '{"email":"test@example.com","username":"test_user"}',
      ),
    ).toBe('v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=');
  });

  it('accepts the secret with or without its prefix, and signs with every active secret', () => {
    expect(secretBytes('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')).toEqual(
      secretBytes('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'),
    );
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    expect(current).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(current).not.toBe(previous);
    const headers = signatureHeaders([current, previous], 'evt_1', 1700000000, '{}');
    expect(headers['webhook-id']).toBe('evt_1');
    expect(headers['webhook-timestamp']).toBe('1700000000');
    expect(headers['webhook-signature']?.split(' ')).toEqual([
      sign(current, 'evt_1', 1700000000, '{}'),
      sign(previous, 'evt_1', 1700000000, '{}'),
    ]);
    // A different body, id or time never shares a signature.
    expect(sign(current, 'evt_1', 1700000000, '{ }')).not.toBe(
      sign(current, 'evt_1', 1700000000, '{}'),
    );
    expect(sign(current, 'evt_2', 1700000000, '{}')).not.toBe(
      sign(current, 'evt_1', 1700000000, '{}'),
    );
    expect(sign(current, 'evt_1', 1700000001, '{}')).not.toBe(
      sign(current, 'evt_1', 1700000000, '{}'),
    );
  });
});

describe('webhook delivery rules', () => {
  it('treats 2xx as success, redirects as failures and 410 as gone', () => {
    expect(judgeResponse(response(204)).outcome).toBe('succeeded');
    const redirect = judgeResponse(response(302, { location: 'http://10.0.0.1/' }));
    expect(redirect).toMatchObject({ outcome: 'redirect', statusCode: 302, gone: false });
    expect(judgeResponse(response(500))).toMatchObject({ outcome: 'http_error', gone: false });
    expect(judgeResponse(response(410))).toMatchObject({ outcome: 'http_error', gone: true });
  });

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(judgeResponse(response(429, { 'retry-after': '120' }), now).retryAfterMs).toBe(120_000);
    expect(
      judgeResponse(response(503, { 'retry-after': 'Fri, 02 Oct 2026 12:05:00 GMT' }), now)
        .retryAfterMs,
    ).toBe(300_000);
    expect(judgeResponse(response(503, { 'retry-after': 'soon' }), now).retryAfterMs).toBeNull();
  });

  it('classifies refused and failed connections', () => {
    expect(judgeError(new EgressError('private_address', 'no')).outcome).toBe('blocked');
    expect(judgeError(new EgressError('host_not_allowed', 'no')).outcome).toBe('blocked');
    expect(judgeError(new EgressError('timeout', 'slow')).outcome).toBe('timeout');
    expect(judgeError(new EgressError('tls', 'bad cert')).outcome).toBe('tls');
    expect(judgeError(new EgressError('unresolvable', 'nx')).outcome).toBe('unresolvable');
  });

  it('backs off exponentially with jitter and stops after the last attempt', () => {
    expect(MAX_ATTEMPTS).toBe(RETRY_DELAYS_MS.length + 1);
    expect(nextAttemptDelay(1, null, () => 0.5)).toBe(5_000);
    expect(nextAttemptDelay(2, null, () => 0.5)).toBe(300_000);
    // ±20% jitter.
    expect(nextAttemptDelay(3, null, () => 0)).toBe(Math.round(30 * 60_000 * 0.8));
    expect(nextAttemptDelay(3, null, () => 1)).toBe(Math.round(30 * 60_000 * 1.2));
    for (let attempt = 1; attempt < MAX_ATTEMPTS - 1; attempt += 1) {
      const now = nextAttemptDelay(attempt, null, () => 0.5) as number;
      const next = nextAttemptDelay(attempt + 1, null, () => 0.5) as number;
      expect(next).toBeGreaterThanOrEqual(now);
    }
    expect(nextAttemptDelay(MAX_ATTEMPTS, null)).toBeNull();
    // Retry-After is honoured, up to a day.
    expect(nextAttemptDelay(1, 600_000, () => 0.5)).toBe(600_000);
    expect(nextAttemptDelay(1, 10 * 86_400_000, () => 0.5)).toBe(86_400_000);
  });

  it('disables an endpoint only after enough failures over enough time', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const base = { now, afterFailures: 10, afterHours: 72 };
    const since = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    expect(shouldDisable({ ...base, consecutiveFailures: 10, failingSince: since(73) })).toBe(true);
    expect(shouldDisable({ ...base, consecutiveFailures: 9, failingSince: since(100) })).toBe(
      false,
    );
    expect(shouldDisable({ ...base, consecutiveFailures: 50, failingSince: since(71) })).toBe(
      false,
    );
    expect(shouldDisable({ ...base, consecutiveFailures: 50, failingSince: null })).toBe(false);
  });

  it('keeps a short printable excerpt of the answer without anything secret', () => {
    const body = Buffer.from(
      `ok\u0000\u0007 token=whsec_${'A'.repeat(43)}= key hv_live_abcdefghjkmn_${'x'.repeat(43)} Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig ${'f'.repeat(40)} ${'y'.repeat(500)}`,
    );
    const excerpt = responseExcerpt(body) as string;
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).not.toMatch(/whsec_|hv_live_|eyJ|f{40}/);
    expect([...excerpt].some((c) => (c.codePointAt(0) ?? 0) < 9)).toBe(false);
    expect(excerpt.startsWith('ok')).toBe(true);
    expect(responseExcerpt(Buffer.alloc(0))).toBeNull();
  });
});

describe('webhook events', () => {
  it('names handoffs by who holds the conversation before and after', () => {
    expect(holder('AI_ACTIVE')).toBe('ai');
    expect(holder('WAITING_HUMAN')).toBe('queue');
    expect(holder('PAUSED')).toBe('queue');
    expect(holder('HUMAN_ACTIVE')).toBe('person');
    expect(handoffType('AI_ACTIVE', 'WAITING_HUMAN')).toBe('handoff.requested');
    expect(handoffType('WAITING_HUMAN', 'HUMAN_ACTIVE')).toBe('handoff.accepted');
    expect(handoffType('AI_ACTIVE', 'HUMAN_ACTIVE')).toBe('handoff.accepted');
    expect(handoffType('HUMAN_ACTIVE', 'AI_ACTIVE')).toBe('handoff.returned');
    expect(handoffType('WAITING_HUMAN', 'PAUSED')).toBeNull();
  });

  it('previews payloads without customer text, names or addresses', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'message.created',
      data: {
        conversationId: 'conv_1',
        message: {
          sender: {
            kind: 'customer',
            displayName: 'Amira Haddad',
            avatarUrl: 'https://x.test/a.png',
          },
          parts: [
            { type: 'text', text: 'My card ends 4242, call me at +971 50 123 4567' },
            { type: 'attachment', name: 'passport.pdf', url: 'https://files.test/signed?x=1' },
          ],
          visibility: 'public',
        },
      },
    });
    const preview = payloadPreview(body);
    const text = JSON.stringify(preview);
    expect(text).not.toMatch(/Amira|4242|\+971|passport|files\.test|x\.test/);
    expect(preview).toMatchObject({
      id: 'evt_1',
      type: 'message.created',
      data: { conversationId: 'conv_1', message: { visibility: 'public' } },
    });
    expect(payloadPreview(null)).toBeNull();
    expect(payloadPreview('not json')).toBeNull();
  });

  it('documents every event type in the published payload schema', () => {
    const types = (WebhookPayload.options as { shape: { type: { value: string } } }[]).map(
      (option) => option.shape.type.value,
    );
    expect(new Set(types)).toEqual(new Set(WEBHOOK_EVENT_TYPES));
  });
});

describe('API keys', () => {
  const ring = () => ({ version: 1, key: randomBytes(32), retired: new Map<number, Buffer>() });

  it('generates prefixed keys that parse back, and finds them in bearer headers', () => {
    const key = generateApiKey();
    expect(key.key).toMatch(/^hv_live_[0-9a-hjkmnp-tv-z]{12}_[0-9A-Za-z]{43}$/);
    expect(parseApiKey(key.key)).toEqual({ prefix: key.prefix, secret: key.secret });
    expect(parseApiKey(`${key.key}x!`)).toBeNull();
    expect(parseApiKey('hv_live_short_secret')).toBeNull();
    expect(bearerApiKey(`Bearer ${key.key}`)).toBe(key.key);
    expect(bearerApiKey('Bearer eyJhbGciOi.widget.token')).toBeNull();
    expect(bearerApiKey(undefined)).toBeNull();
    expect(generateApiKey().key).not.toBe(key.key);
  });

  it('stores only an HMAC that a database copy cannot check guesses against', () => {
    const keys = ring();
    const hasher = new ApiKeyHasher(keys);
    const { secret } = generateApiKey();
    const stored = hasher.hash(secret);
    expect(stored.toString('utf8')).not.toContain(secret);
    expect(hasher.verify(secret, stored, 1)).toBe(true);
    expect(hasher.verify(`${secret.slice(0, -1)}x`, stored, 1)).toBe(false);
    // Another deployment's key-encryption key gives another HMAC.
    expect(new ApiKeyHasher(ring()).verify(secret, stored, 1)).toBe(false);
    // After a KEK rotation the old version still verifies (and is rehashed on use).
    const rotated = new ApiKeyHasher({
      version: 2,
      key: randomBytes(32),
      retired: new Map([[1, keys.key]]),
    });
    expect(rotated.verify(secret, stored, 1)).toBe(true);
    expect(rotated.version).toBe(2);
  });

  it('offers keys exactly the permissions the policy allows them', () => {
    expect([...ApiKeyPermission.options].sort()).toEqual([...API_KEY_PERMISSIONS].sort());
  });
});

describe('plan limit problems', () => {
  it('answers 402 with the limit and numbers from a database guard', () => {
    const pgError = Object.assign(new Error('plan limit reached: seats'), {
      code: 'HN402',
      detail: 'seats',
      hint: '{"max" : 3, "used" : 3}',
    });
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
    const problem = toProblem(wrapped, 'req-1');
    expect(problem).toMatchObject({
      status: 402,
      code: 'PLAN_LIMIT_REACHED',
      quota: { scope: 'plan', limit: 'seats', max: 3, used: 3, resetsAt: null },
    });
    expect(
      planLimitFromDatabase(Object.assign(new Error('x'), { code: 'HN402', detail: 'nope' })),
    ).toBeNull();
    expect(toProblem(Object.assign(new Error('x'), { code: '23505' }), 'r').code).toBe('INTERNAL');
  });

  it('carries the quota of an application error', () => {
    const error = new AppError('RATE_LIMITED', {
      retryAfter: 12,
      quota: { scope: 'api_key', limit: 'requestsPerMinute', max: 120, used: 121, resetsAt: null },
    });
    expect(toProblem(error, 'r')).toMatchObject({
      status: 429,
      retryAfter: 12,
      quota: { scope: 'api_key', max: 120 },
    });
  });
});
