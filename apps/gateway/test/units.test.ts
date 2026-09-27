import { randomBytes } from 'node:crypto';
import { InvalidPublicIdError } from '@hamnivo/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/app-error.js';
import { toProblem } from '../src/common/problem.filter.js';
import { requestIdFrom } from '../src/common/request-id.js';
import { loadConfig } from '../src/config.js';
import { deterministicUuid } from '../src/identity/tenants.service.js';
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
