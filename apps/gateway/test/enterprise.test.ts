import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EgressError, type Resolver } from '@hamnivo/adapters/net';
import { describe, expect, it } from 'vitest';
import { csvField, csvHeader, ndjsonLine } from '../src/audit/audit-export.js';
import { fetchJson, OutboundResponseError } from '../src/common/outbound.js';
import { discoverOidc } from '../src/identity/sso/discovery.js';
import { checkVerificationRecord, verificationRecord } from '../src/identity/sso/dns.js';
import { emailDomain } from '../src/identity/sso/sso-runtime.js';
import { supportState } from '../src/support/views.js';

const noTrust = { trustedOrigins: [] as string[] };

const PUBLIC = { address: '93.184.215.14', family: 4 } as const;
const LOOPBACK = { address: '127.0.0.1', family: 4 } as const;

async function problem(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError || error instanceof OutboundResponseError) {
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

/**
 * Which addresses an identity provider's server may be reached at is decided by the one egress
 * guard (`@hamnivo/adapters/net`, tested there: address ranges, URL rules, DNS rebinding). These
 * tests are what SSO adds: reading the discovery document under it.
 */
describe('outbound requests for tenants (SSRF)', () => {
  it('checks the address again when it connects, so a name cannot rebind to a private one', async () => {
    // The first lookup (when the URL is checked) is public, the next (when connecting) is not.
    let lookups = 0;
    const rebinding = {
      ...noTrust,
      resolve: async () => (lookups++ === 0 ? [PUBLIC] : [LOOPBACK]),
    };
    expect(await problem(fetchJson('https://idp.example.com/.well-known/x', rebinding))).toBe(
      'private_address',
    );
    expect(lookups).toBe(2);
  });

  it('refuses an identity provider whose name turns private between the check and the connection', async () => {
    // Two lookups check the issuer and the discovery URL; the third is the connection.
    let lookups = 0;
    const policy = {
      ...noTrust,
      resolve: async () => (++lookups <= 2 ? [PUBLIC] : [LOOPBACK]),
    };
    await expect(discoverOidc('https://idp.example.com', policy)).rejects.toMatchObject({
      code: 'issuer_unreachable',
    });
    expect(lookups).toBe(3);
  });

  it('says why an issuer is refused', async () => {
    const resolve: Resolver = async () => [PUBLIC];
    const refused = async (issuer: string) => {
      try {
        await discoverOidc(issuer, { ...noTrust, resolve });
        return null;
      } catch (error) {
        return error as { code: string; message: string };
      }
    };
    expect(await refused('http://idp.example.com')).toMatchObject({
      code: 'issuer_invalid',
      message: 'The issuer must use HTTPS.',
    });
    expect(await refused('https://10.0.0.5')).toMatchObject({
      code: 'issuer_invalid',
      message: 'The issuer is on a private network. A server administrator can allow it.',
    });
    expect(await refused('https://sso.corp.internal')).toMatchObject({ code: 'issuer_invalid' });
    expect(await refused('https://user:pw@idp.example.com')).toMatchObject({
      code: 'issuer_invalid',
      message: 'The issuer address could not be used.',
    });
    expect(await refused('not a url')).toMatchObject({ code: 'issuer_invalid' });
  });

  it('never follows redirects and limits the size of what it reads', async () => {
    const server = await serve((url) =>
      url === '/redirect'
        ? { status: 302, headers: { location: 'http://169.254.169.254/' } }
        : url === '/big'
          ? { status: 200, body: JSON.stringify({ pad: 'x'.repeat(300_000) }) }
          : url === '/error'
            ? { status: 503 }
            : url === '/text'
              ? { status: 200, body: 'not json' }
              : { status: 200, body: '{"ok":true}' },
    );
    try {
      const policy = { trustedOrigins: [server.origin] };
      expect(await fetchJson(`${server.origin}/fine`, policy)).toEqual({ ok: true });
      expect(await problem(fetchJson(`${server.origin}/redirect`, policy))).toBe('redirect');
      expect(await problem(fetchJson(`${server.origin}/big`, policy))).toBe('too_large');
      expect(await problem(fetchJson(`${server.origin}/big`, policy, { maxBytes: 400_000 }))).toBe(
        'none',
      );
      expect(await problem(fetchJson(`${server.origin}/error`, policy))).toBe('status');
      expect(await problem(fetchJson(`${server.origin}/text`, policy))).toBe('not_json');
      expect(await problem(fetchJson(`${server.origin}/fine`, noTrust))).toBe('insecure_url');
    } finally {
      await server.close();
    }
  });

  it('gives up on a provider that does not answer in time or cannot be reached', async () => {
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    try {
      const policy = { trustedOrigins: [origin] };
      expect(await problem(fetchJson(`${origin}/slow`, policy, { timeoutMs: 200 }))).toBe(
        'timeout',
      );
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
    const closed = 'http://127.0.0.1:1';
    expect(await problem(fetchJson(`${closed}/x`, { trustedOrigins: [closed] }))).toBe('network');
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
