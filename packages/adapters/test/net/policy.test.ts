import { describe, expect, it } from 'vitest';
import {
  checkDestination,
  checkUrl,
  EgressError,
  type EgressPolicy,
  hostAllowed,
  normalizeHostPattern,
  type Resolver,
} from '../../src/net/index.js';

const publicDns: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const policy: EgressPolicy = { resolve: publicDns };

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error.problem;
    throw error;
  }
  return 'allowed';
}

describe('checkUrl', () => {
  it('accepts a public HTTPS address', () => {
    expect(checkUrl('https://hooks.example.com/support', policy)).toMatchObject({
      trusted: false,
    });
  });

  it.each([
    ['http://hooks.example.com/support', 'insecure_url'],
    ['ftp://hooks.example.com/', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['https://user:pass@hooks.example.com/', 'invalid_url'],
    ['https://127.0.0.1/', 'private_address'],
    ['https://2130706433/', 'private_address'],
    ['https://0x7f.1/', 'private_address'],
    ['https://0.0.0.0/', 'private_address'],
    ['https://[::1]/', 'private_address'],
    ['https://[::ffff:169.254.169.254]/latest/meta-data/', 'private_address'],
    ['https://169.254.169.254/latest/meta-data/', 'private_address'],
    ['https://10.0.0.8:8443/hook', 'private_address'],
    ['https://localhost/', 'private_address'],
    ['https://api.localhost/', 'private_address'],
    ['https://metadata.google.internal/', 'private_address'],
    ['https://printer/', 'private_address'],
    ['https://nas.local/', 'private_address'],
  ])('%s is refused (%s)', async (url, problem) => {
    expect(await problemOf(Promise.resolve().then(() => checkUrl(url, policy)))).toBe(problem);
  });

  it('allows plain HTTP and private addresses only for origins the administrator trusts', () => {
    const trusted = { ...policy, trustedOrigins: ['http://127.0.0.1:8080'] };
    expect(checkUrl('http://127.0.0.1:8080/hook', trusted).trusted).toBe(true);
    expect(() => checkUrl('http://127.0.0.1:8081/hook', trusted)).toThrow(EgressError);
  });
});

describe('the tenant allowlist', () => {
  it('matches exact hosts and subdomains of wildcards, never the wildcard apex', () => {
    const list = ['hooks.northline.example', '*.acme.example'];
    expect(hostAllowed('hooks.northline.example', list)).toBe(true);
    expect(hostAllowed('HOOKS.northline.example.', list)).toBe(true);
    expect(hostAllowed('alerts.northline.example', list)).toBe(false);
    expect(hostAllowed('api.acme.example', list)).toBe(true);
    expect(hostAllowed('a.b.acme.example', list)).toBe(true);
    expect(hostAllowed('acme.example', list)).toBe(false);
    expect(hostAllowed('evilacme.example', list)).toBe(false);
    expect(hostAllowed('anything.example', [])).toBe(true);
  });

  it('refuses a host that is not on the list before any lookup', async () => {
    let lookups = 0;
    const counting: Resolver = async (host) => {
      lookups += 1;
      return publicDns(host);
    };
    const limited = { resolve: counting, allowedHosts: ['hooks.northline.example'] };
    expect(await problemOf(checkDestination('https://hooks.northline.example/a', limited))).toBe(
      'allowed',
    );
    expect(await problemOf(checkDestination('https://evil.example/a', limited))).toBe(
      'host_not_allowed',
    );
    expect(lookups).toBe(1);
  });

  it.each([
    ['Hooks.Example.COM.', 'hooks.example.com'],
    ['*.example.com', '*.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['93.184.216.34', '93.184.216.34'],
    ['localhost', null],
    ['intranet', null],
    ['*.internal', null],
    ['10.0.0.1', null],
    ['exa mple.com', null],
    ['*', null],
    ['-bad.example', null],
    ['example.123', null],
  ])('normalizes the entry %s to %s', (input, output) => {
    expect(normalizeHostPattern(input)).toBe(output);
  });
});

describe('checkDestination', () => {
  it('refuses a name that resolves to a private address, or partly does', async () => {
    const internal: Resolver = async () => [{ address: '10.0.0.7', family: 4 }];
    const mixed: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::7', family: 6 },
    ];
    expect(
      await problemOf(checkDestination('https://hooks.example.com', { resolve: internal })),
    ).toBe('private_address');
    expect(await problemOf(checkDestination('https://hooks.example.com', { resolve: mixed }))).toBe(
      'private_address',
    );
  });

  it('reports a name that does not resolve', async () => {
    const none: Resolver = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await problemOf(checkDestination('https://nowhere.example', { resolve: none }))).toBe(
      'unresolvable',
    );
  });
});
