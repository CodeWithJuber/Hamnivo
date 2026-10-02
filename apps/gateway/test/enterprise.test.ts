import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { csvField, csvHeader, ndjsonLine } from '../src/audit/audit-export.js';
import {
  assertFetchable,
  fetchJson,
  isPublicAddress,
  OutboundResponseError,
  OutboundUrlError,
} from '../src/common/outbound.js';
import { discoverOidc } from '../src/identity/sso/discovery.js';
import { checkVerificationRecord, verificationRecord } from '../src/identity/sso/dns.js';
import { emailDomain } from '../src/identity/sso/sso-runtime.js';
import { supportState } from '../src/support/views.js';

const noTrust = { trustedOrigins: [] as string[] };

async function problem(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OutboundUrlError || error instanceof OutboundResponseError) {
      return error.problem;
    }
    throw error;
  }
  return 'none';
}

/** A local HTTP server answering every request with `answer`, for one test. */
async function serve(
  answer: (url: string) => { status: number; body?: string; headers?: Record<string, string> },
) {
  const server = createServer((request, response) => {
    const { status, body, headers } = answer(request.url ?? '/');
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('outbound requests for tenants (SSRF)', () => {
  it('knows which addresses are private', () => {
    for (const address of [
      '127.0.0.1',
      '10.2.3.4',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.4.4']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('allows only HTTPS to public addresses, or origins the administrator trusts', async () => {
    const publicResolver = { ...noTrust, resolve: async () => ['93.184.215.14'] };
    const rebinding = { ...noTrust, resolve: async () => ['93.184.215.14', '10.0.0.7'] };
    expect(await problem(assertFetchable('https://idp.example.com/x', publicResolver))).toBe(
      'none',
    );
    expect(await problem(assertFetchable('http://idp.example.com/x', publicResolver))).toBe(
      'insecure_url',
    );
    expect(await problem(assertFetchable('https://idp.example.com/x', rebinding))).toBe(
      'private_host',
    );
    expect(await problem(assertFetchable('https://169.254.169.254/latest', noTrust))).toBe(
      'private_host',
    );
    expect(await problem(assertFetchable('https://[::1]/x', noTrust))).toBe('private_host');
    expect(await problem(assertFetchable('https://sso.corp.internal/x', noTrust))).toBe(
      'private_host',
    );
    expect(await problem(assertFetchable('https://user:pw@idp.example.com/', noTrust))).toBe(
      'invalid_url',
    );
    expect(await problem(assertFetchable('not a url', noTrust))).toBe('invalid_url');
    const failing = {
      ...noTrust,
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    };
    expect(await problem(assertFetchable('https://nowhere.example/x', failing))).toBe(
      'unresolvable',
    );
    const trusted = { trustedOrigins: ['http://127.0.0.1:9000'] };
    expect(await problem(assertFetchable('http://127.0.0.1:9000/x', trusted))).toBe('none');
    expect(await problem(assertFetchable('http://127.0.0.1:9001/x', trusted))).toBe('insecure_url');
  });

  it('checks the address again when it connects, so a name cannot rebind to a private one', async () => {
    // The first lookup (when the URL is checked) is public, the next (when connecting) is not.
    let lookups = 0;
    const rebinding = {
      ...noTrust,
      resolve: async () => (lookups++ === 0 ? ['93.184.215.14'] : ['127.0.0.1']),
    };
    expect(await problem(fetchJson('https://idp.example.com/.well-known/x', rebinding))).toBe(
      'private_host',
    );
    expect(lookups).toBe(2);
  });

  it('never follows redirects and limits the size of what it reads', async () => {
    const server = await serve((url) =>
      url === '/redirect'
        ? { status: 302, headers: { location: 'http://169.254.169.254/' } }
        : url === '/big'
          ? { status: 200, body: JSON.stringify({ pad: 'x'.repeat(300_000) }) }
          : { status: 200, body: '{"ok":true}' },
    );
    try {
      const policy = { trustedOrigins: [server.origin] };
      expect(await fetchJson(`${server.origin}/fine`, policy)).toEqual({ ok: true });
      expect(await problem(fetchJson(`${server.origin}/redirect`, policy))).toBe('redirect');
      expect(await problem(fetchJson(`${server.origin}/big`, policy))).toBe('too_large');
      expect(await problem(fetchJson(`${server.origin}/fine`, noTrust))).toBe('insecure_url');
    } finally {
      await server.close();
    }
  });

  it('checks that the discovery document names the issuer and safe endpoints', async () => {
    let document: Record<string, unknown> = {};
    const server = await serve(() => ({ status: 200, body: JSON.stringify(document) }));
    try {
      const policy = { trustedOrigins: [server.origin] };
      const issuer = server.origin;
      document = {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      };
      expect(await discoverOidc(issuer, policy)).toEqual({
        authorization: `${issuer}/auth`,
        token: `${issuer}/token`,
        jwks: `${issuer}/jwks`,
        userInfo: null,
        tokenEndpointAuth: 'client_secret_post',
      });
      const codeOf = async () => {
        try {
          await discoverOidc(issuer, policy);
          return 'none';
        } catch (error) {
          return (error as { code: string }).code;
        }
      };
      document = { ...document, issuer: 'https://someone-else.example' };
      expect(await codeOf()).toBe('issuer_mismatch');
      document = { ...document, issuer, token_endpoint: 'https://10.0.0.5/token' };
      expect(await codeOf()).toBe('endpoint_not_allowed');
      document = { ...document, token_endpoint: undefined };
      expect(await codeOf()).toBe('incomplete');
      document = {
        ...document,
        token_endpoint: `${issuer}/token`,
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      };
      expect(await codeOf()).toBe('unsupported_client_auth');
    } finally {
      await server.close();
    }
  });
});

describe('domain verification', () => {
  it('names the record and matches it exactly, joining chunked TXT strings', async () => {
    const record = verificationRecord('northline.example', 'tok123');
    expect(record).toEqual({
      name: '_hamnivo-verification.northline.example',
      value: 'hamnivo-verification=tok123',
    });
    const answer = (txt: string[][] | Error) => ({
      resolveTxt: async () => {
        if (txt instanceof Error) throw txt;
        return txt;
      },
    });
    const check = (txt: string[][] | Error) =>
      checkVerificationRecord(answer(txt), 'northline.example', 'tok123');
    expect(await check([['hamnivo-verification=', 'tok123']])).toBe('verified');
    expect(await check([['hamnivo-verification=tok1234']])).toBe('not_found');
    expect(await check([['v=spf1 -all']])).toBe('not_found');
    expect(await check(Object.assign(new Error('x'), { code: 'ENODATA' }))).toBe('not_found');
    expect(await check(Object.assign(new Error('x'), { code: 'ETIMEOUT' }))).toBe('lookup_failed');
  });

  it('reads the email domain case-insensitively', () => {
    expect(emailDomain(' Lina@NorthLine.Example ')).toBe('northline.example');
    expect(emailDomain('no-at-sign')).toBe('');
  });
});

describe('audit export', () => {
  it('neutralises spreadsheet formulas and quotes CSV fields', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField('\tx')).toBe("'\tx");
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=a,"b"')).toBe(`"'=a,""b"""`);
    expect(csvField(null)).toBe('');
    expect(csvField(42)).toBe('42');
    expect(csvHeader().endsWith('\r\n')).toBe(true);
  });

  it('writes one JSON object per line with the chain hashes', () => {
    const line = ndjsonLine({
      tenantId: 't',
      seq: 7,
      id: 'e',
      occurredAt: new Date('2026-09-27T10:00:00Z'),
      actorType: 'staff',
      actorId: 'stf_1',
      action: 'role.created',
      targetType: null,
      targetId: null,
      outcome: 'success',
      reason: null,
      requestId: null,
      data: { key: 'triage' },
      prevHash: Buffer.alloc(32, 1),
      hash: Buffer.alloc(32, 2),
    } as Parameters<typeof ndjsonLine>[0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      seq: 7,
      target: null,
      prevHash: '01'.repeat(32),
      hash: '02'.repeat(32),
    });
  });
});

describe('support grant state', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const base = {
    status: 'approved',
    revokedAt: null,
    endedAt: null,
    expiresAt: new Date('2026-09-27T12:30:00Z'),
  } as unknown as Parameters<typeof supportState>[0];

  it('is active only while approved, not revoked or ended, and before its end time', () => {
    expect(supportState(base, now)).toBe('active');
    expect(supportState({ ...base, status: 'pending' }, now)).toBe('pending');
    expect(supportState({ ...base, status: 'declined' }, now)).toBe('declined');
    expect(supportState({ ...base, revokedAt: now }, now)).toBe('revoked');
    expect(supportState({ ...base, endedAt: now }, now)).toBe('ended');
    expect(supportState(base, new Date('2026-09-27T12:30:00Z'))).toBe('expired');
  });
});
