import { randomBytes } from 'node:crypto';
import { InvalidPublicIdError } from '@hamnivo/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isImportEvent } from '../src/authority/ingress.service.js';
import {
  nextReconcileInterval,
  RECONCILE_MIN_SECONDS,
  reconcileCeiling,
} from '../src/authority/reconcile-policy.js';
import { AppError } from '../src/common/app-error.js';
import { toProblem } from '../src/common/problem.filter.js';
import { requestIdFrom } from '../src/common/request-id.js';
import { loadConfig } from '../src/config.js';
import { deterministicUuid } from '../src/identity/tenants.service.js';
import { checkSourceUrl, guardedFetch, isPublicAddress } from '../src/migration/source-guard.js';
import { retryDelayMs } from '../src/outbox/relay.service.js';
import { hintOf, type KeyRing, open, rewrap, seal, secretAad } from '../src/secrets/envelope.js';

const ring = (version = 1, retired = new Map<number, Buffer>()): KeyRing => ({
  version,
  key: randomBytes(32),
  retired,
});

describe('envelope encryption', () => {
  it('round-trips and binds ciphertext to its tenant and row', () => {
    const keys = ring();
    const aad = secretAad('tenant-a', 'secret-1');
    const sealed = seal(keys, 'p@ssw0rd✓', aad);
    expect(open(keys, sealed, aad)).toBe('p@ssw0rd✓');
    expect(() => open(keys, sealed, secretAad('tenant-b', 'secret-1'))).toThrow();
    expect(() => open(keys, sealed, secretAad('tenant-a', 'secret-2'))).toThrow();
  });

  it('detects tampering and wrong keys', () => {
    const keys = ring();
    const aad = secretAad('t', 's');
    const sealed = seal(keys, 'value', aad);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => open(keys, { ...sealed, ciphertext: flipped }, aad)).toThrow();
    expect(() => open(ring(), sealed, aad)).toThrow();
  });

  it('rewraps data keys onto a new key-encryption key without re-encrypting', () => {
    const v1 = ring(1);
    const aad = secretAad('t', 's');
    const sealed = seal(v1, 'value', aad);
    const v2 = { version: 2, key: randomBytes(32), retired: new Map([[1, v1.key]]) };
    const moved = rewrap(v2, sealed);
    expect(moved.kekVersion).toBe(2);
    expect(moved.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(open({ ...v2, retired: new Map() }, moved, aad)).toBe('value');
    expect(() => open({ ...v2, retired: new Map() }, sealed, aad)).toThrow(/version 1/);
  });

  it('shows at most four characters and never more than a quarter', () => {
    expect(hintOf('abc')).toBe('');
    expect(hintOf('abcdefgh')).toBe('gh');
    expect(hintOf('cw-token-0123456789abcdef')).toBe('cdef');
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://app@localhost/hamnivo',
    HAMNIVO_KEK_BASE64: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: 'x'.repeat(32),
  };

  it('applies safe defaults and parses retired keys', () => {
    const retired = randomBytes(32).toString('base64');
    const config = loadConfig({
      ...base,
      HAMNIVO_KEK_VERSION: '3',
      HAMNIVO_KEK_RETIRED: `2:${retired}`,
    });
    expect(config.PORT).toBe(4000);
    expect(config.REQUIRE_EMAIL_VERIFICATION).toBe(true);
    expect(config.kek.version).toBe(3);
    expect(config.kek.retired.get(2)?.toString('base64')).toBe(retired);
  });

  it('refuses to start with a weak or missing key', () => {
    expect(() => loadConfig({ ...base, HAMNIVO_KEK_BASE64: 'c2hvcnQ=' })).toThrow(
      /HAMNIVO_KEK_BASE64/,
    );
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => loadConfig({ HAMNIVO_KEK_BASE64: base.HAMNIVO_KEK_BASE64 })).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe('errors and identifiers', () => {
  it('maps failures to problem details without leaking internals', () => {
    expect(
      toProblem(new AppError('SCOPE_DENIED', { detail: 'No.', internal: { secret: 1 } }), 'req_1'),
    ).toMatchObject({
      status: 403,
      code: 'SCOPE_DENIED',
      detail: 'No.',
    });
    expect(
      JSON.stringify(toProblem(new AppError('SCOPE_DENIED', { internal: { secret: 1 } }), 'r')),
    ).not.toContain('secret');
    expect(toProblem(new NotFoundException(), 'r').code).toBe('NOT_FOUND');
    expect(toProblem(new InvalidPublicIdError('conversation', 'x'), 'r').code).toBe('NOT_FOUND');
    expect(toProblem(Object.assign(new Error('Rate limit'), { statusCode: 429 }), 'r').code).toBe(
      'RATE_LIMITED',
    );
    const internal = toProblem(new Error('db password is hunter2'), 'r');
    expect(internal.code).toBe('INTERNAL');
    expect(JSON.stringify(internal)).not.toContain('hunter2');
  });

  it('accepts well-formed upstream request ids and mints its own otherwise', () => {
    expect(requestIdFrom('lb-2f1c9a2e0b7d3c6f')).toBe('lb-2f1c9a2e0b7d3c6f');
    expect(requestIdFrom('<script>')).toMatch(/^req_/);
    expect(requestIdFrom(undefined)).toMatch(/^req_/);
  });

  it('derives stable RFC 9562 version-8 UUIDs', () => {
    const id = deterministicUuid('tenant:user:key');
    expect(id).toBe(deterministicUuid('tenant:user:key'));
    expect(id).not.toBe(deterministicUuid('tenant:user:other'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('backs off exponentially with jitter up to ten minutes', () => {
    for (let attempt = 1; attempt < 20; attempt += 1) {
      const delay = retryDelayMs(attempt);
      const cap = Math.min(600_000, 1000 * 2 ** (attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(cap / 2);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });
});

describe('reconciler polling', () => {
  it('polls soon after news, then backs off up to a ceiling that depends on the conversation', () => {
    expect(nextReconcileInterval(120, true, 60)).toBe(RECONCILE_MIN_SECONDS);
    expect(nextReconcileInterval(15, false, 60)).toBe(30);
    expect(nextReconcileInterval(30, false, 60)).toBe(60);
    expect(nextReconcileInterval(60, false, 60)).toBe(60);
    expect(nextReconcileInterval(0, false, 60)).toBe(30);
    expect(reconcileCeiling('pending', 'AI_ACTIVE')).toBe(60);
    expect(reconcileCeiling('open', 'WAITING_HUMAN')).toBe(60);
    expect(reconcileCeiling('open', 'HUMAN_ACTIVE')).toBe(120);
    expect(reconcileCeiling('snoozed', 'HUMAN_ACTIVE')).toBe(600);
    expect(reconcileCeiling('resolved', 'AI_ACTIVE')).toBe(3600);
  });
});

describe('webhook intake of imported history', () => {
  const inboxes = new Set([42]);

  it('drops events about import inboxes, imported conversations and imported contacts', () => {
    expect(isImportEvent({ event: 'message_created', inbox: { id: 42 } }, inboxes)).toBe(true);
    expect(
      isImportEvent(
        { event: 'message_created', conversation: { inbox_id: 42, custom_attributes: {} } },
        inboxes,
      ),
    ).toBe(true);
    // Before the intake knows the new import inbox, the conversation's key still gives it away.
    expect(
      isImportEvent(
        {
          event: 'conversation_status_changed',
          inbox_id: 7,
          custom_attributes: { hv_import_key: 'hv1:imp:mig_1:c:conv-1' },
        },
        inboxes,
      ),
    ).toBe(true);
    expect(
      isImportEvent({ event: 'contact_created', identifier: 'hv:imp:mig_1:abc' }, inboxes),
    ).toBe(true);
  });

  it('keeps every other event', () => {
    expect(isImportEvent({ event: 'message_created', inbox: { id: 7 } }, inboxes)).toBe(false);
    expect(
      isImportEvent(
        { event: 'conversation_updated', inbox_id: 7, custom_attributes: { hv_import_key: 'x' } },
        inboxes,
      ),
    ).toBe(false);
    expect(isImportEvent({ event: 'contact_created', identifier: 'cust_881' }, inboxes)).toBe(
      false,
    );
    expect(isImportEvent(null, inboxes)).toBe(false);
  });
});

describe('source addresses of imports (M04)', () => {
  it('tells public addresses from internal ones, IPv4 and IPv6', () => {
    for (const address of [
      '93.184.215.14',
      '8.8.8.8',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:0:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '100::1',
      'fec0::1',
      'not-an-address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts only https URLs without credentials that point outside the network', async () => {
    await expect(checkSourceUrl('https://93.184.215.14/app/', false)).resolves.toEqual(
      new URL('https://93.184.215.14'),
    );
    for (const [url, code] of [
      ['http://93.184.215.14', 'insecure_url'],
      ['ftp://93.184.215.14', 'insecure_url'],
      ['https://user:pass@93.184.215.14', 'invalid_url'],
      ['https://127.0.0.1', 'private_address'],
      ['https://[::1]', 'private_address'],
      ['https://localhost', 'private_address'],
      ['not a url', 'invalid_url'],
    ] as const) {
      await expect(checkSourceUrl(url, false), url).rejects.toMatchObject({ code });
    }
    // Development and tests may read a Chatwoot on this machine.
    await expect(checkSourceUrl('http://127.0.0.1:3000', true)).resolves.toBeInstanceOf(URL);
  });

  it('refuses to connect to internal addresses, even when a URL got past the first check', async () => {
    const guarded = guardedFetch(false);
    await expect(guarded('http://127.0.0.1:9/api/v1/profile')).rejects.toThrow();
    await expect(guarded('http://localhost:9/api/v1/profile')).rejects.toThrow(/fetch failed/);
  });
});
