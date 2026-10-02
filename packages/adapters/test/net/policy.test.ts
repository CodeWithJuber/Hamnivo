import { describe, expect, it } from 'vitest';
import {
  checkDestination,
  checkUrl,
  EgressError,
  type EgressPolicy,
  hostAllowed,
  normalizeHost,
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

const urlProblem = (url: string, against: EgressPolicy = policy) =>
  problemOf(Promise.resolve().then(() => checkUrl(url, against)));

describe('checkUrl', () => {
  it('accepts a public HTTPS address', () => {
    expect(checkUrl('https://hooks.example.com/support', policy)).toMatchObject({
      trusted: false,
    });
  });

  it.each([
    ['http://hooks.example.com/support', 'insecure_url'],
    ['ftp://hooks.example.com/', 'insecure_url'],
    ['ws://hooks.example.com/', 'insecure_url'],
    ['file:///etc/passwd', 'insecure_url'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['https://user:pass@hooks.example.com/', 'invalid_url'],
    ['https://user@hooks.example.com/', 'invalid_url'],
    ['https://127.0.0.1/', 'private_address'],
    ['https://2130706433/', 'private_address'],
    ['https://0x7f.1/', 'private_address'],
    ['https://127.1/', 'private_address'],
    ['https://0.0.0.0/', 'private_address'],
    ['https://[::1]/', 'private_address'],
    ['https://[::ffff:169.254.169.254]/latest/meta-data/', 'private_address'],
    ['https://[::ffff:0:10.0.0.1]/', 'private_address'],
    ['https://[64:ff9b::a00:1]/', 'private_address'],
    ['https://169.254.169.254/latest/meta-data/', 'private_address'],
    ['https://10.0.0.8:8443/hook', 'private_address'],
    ['https://localhost/', 'private_address'],
    ['https://localhost./', 'private_address'],
    ['https://localhost../', 'private_address'],
    ['https://LOCALHOST/', 'private_address'],
    ['https://api.localhost/', 'private_address'],
    ['https://metadata.google.internal/', 'private_address'],
    ['https://sso.corp.internal/x', 'private_address'],
    ['https://printer/', 'private_address'],
    ['https://nas.local/', 'private_address'],
    ['https://host.localdomain/', 'private_address'],
    ['https://box.home.arpa/', 'private_address'],
    ['https://wiki.intranet/', 'private_address'],
    ['https://router.lan/', 'private_address'],
    ['https://erp.corp/', 'private_address'],
    ['https://tv.home/', 'private_address'],
    ['https://4.3.2.1.in-addr.arpa/', 'private_address'],
    ['https://1.0.0.0.ip6.arpa/', 'private_address'],
  ])('%s is refused (%s)', async (url, problem) => {
    expect(await urlProblem(url)).toBe(problem);
  });

  it('refuses what is not HTTPS before anything else, credentials included', async () => {
    const trusted = { trustedOrigins: ['http://127.0.0.1:8080'] };
    expect(await urlProblem('http://user:pw@127.0.0.1:8080/', trusted)).toBe('invalid_url');
    expect(await urlProblem('ftp://127.0.0.1:8080/', trusted)).toBe('insecure_url');
  });

  it('allows plain HTTP and private addresses only for origins the administrator trusts', async () => {
    const trusted = { ...policy, trustedOrigins: ['http://127.0.0.1:8080'] };
    expect(checkUrl('http://127.0.0.1:8080/hook', trusted).trusted).toBe(true);
    // The exact origin: another port, another scheme and another host are not trusted.
    expect(await urlProblem('http://127.0.0.1:8081/hook', trusted)).toBe('insecure_url');
    expect(await urlProblem('https://127.0.0.1:8080/hook', trusted)).toBe('private_address');
    expect(await urlProblem('http://127.0.0.2:8080/hook', trusted)).toBe('insecure_url');
    // A private name needs its own trust, and gets it for its own origin only.
    const named = { trustedOrigins: ['https://idp.corp.internal'] };
    expect(checkUrl('https://idp.corp.internal/.well-known/x', named).trusted).toBe(true);
    expect(await urlProblem('https://idp.corp.internal:8443/', named)).toBe('private_address');
    expect(await urlProblem('https://other.corp.internal/', named)).toBe('private_address');
  });

  it('refuses a host that is not on the allowlist, trusted origins excepted', async () => {
    const limited = {
      allowedHosts: ['hooks.example.com'],
      trustedOrigins: ['http://10.0.0.5:8080'],
    };
    expect(await urlProblem('https://hooks.example.com/a', limited)).toBe('allowed');
    expect(await urlProblem('https://evil.example/a', limited)).toBe('host_not_allowed');
    expect(await urlProblem('http://10.0.0.5:8080/a', limited)).toBe('allowed');
    // An address is judged before the list: a listed private literal is still refused.
    expect(await urlProblem('https://10.0.0.5/a', { allowedHosts: ['10.0.0.5'] })).toBe(
      'private_address',
    );
  });
});

describe('the allowlist', () => {
  it('matches exact hosts and subdomains of wildcards, never the wildcard apex', () => {
    const list = ['hooks.northline.example', '*.acme.example'];
    expect(hostAllowed('hooks.northline.example', list)).toBe(true);
    expect(hostAllowed('HOOKS.northline.example.', list)).toBe(true);
    expect(hostAllowed('hooks.northline.example..', list)).toBe(true);
    expect(hostAllowed('alerts.northline.example', list)).toBe(false);
    expect(hostAllowed('api.acme.example', list)).toBe(true);
    expect(hostAllowed('a.b.acme.example', list)).toBe(true);
    expect(hostAllowed('acme.example', list)).toBe(false);
    expect(hostAllowed('evilacme.example', list)).toBe(false);
    expect(hostAllowed('orders.example.com.evil.net', ['orders.example.com'])).toBe(false);
    expect(hostAllowed('[::1]', ['::1'])).toBe(true);
  });

  it('allows every host without a list, and none with an empty one', async () => {
    expect(hostAllowed('anything.example', undefined)).toBe(true);
    expect(hostAllowed('anything.example', [])).toBe(false);
    expect(await urlProblem('https://anything.example/a', { allowedHosts: [] })).toBe(
      'host_not_allowed',
    );
    expect(await urlProblem('https://anything.example/a', {})).toBe('allowed');
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

  it('compares hosts without brackets, case or trailing dots', () => {
    expect(normalizeHost(' [::1] ')).toBe('::1');
    expect(normalizeHost('Example.COM..')).toBe('example.com');
  });
});

describe('checkDestination', () => {
  it('accepts a public name and a trusted origin without resolving it', async () => {
    let lookups = 0;
    const counting: Resolver = async (host) => {
      lookups += 1;
      return publicDns(host);
    };
    const trusted = { resolve: counting, trustedOrigins: ['http://idp.corp.internal:9000'] };
    expect(await problemOf(checkDestination('https://idp.example.com/x', trusted))).toBe('allowed');
    expect(lookups).toBe(1);
    expect(await problemOf(checkDestination('http://idp.corp.internal:9000/x', trusted))).toBe(
      'allowed',
    );
    expect(lookups).toBe(1);
  });

  it('refuses a name that resolves to a private address, or partly does', async () => {
    const internal: Resolver = async () => [{ address: '10.0.0.7', family: 4 }];
    const mixed: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::7', family: 6 },
    ];
    const mappedLoopback: Resolver = async () => [{ address: '::ffff:127.0.0.1', family: 6 }];
    expect(
      await problemOf(checkDestination('https://hooks.example.com', { resolve: internal })),
    ).toBe('private_address');
    expect(await problemOf(checkDestination('https://hooks.example.com', { resolve: mixed }))).toBe(
      'private_address',
    );
    expect(
      await problemOf(checkDestination('https://hooks.example.com', { resolve: mappedLoopback })),
    ).toBe('private_address');
  });

  it('applies the URL rules first, so a bad address is never resolved', async () => {
    let lookups = 0;
    const counting: Resolver = async () => {
      lookups += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    for (const url of [
      'http://idp.example.com/x',
      'https://user:pw@idp.example.com/',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://sso.corp.internal/x',
      'not a url',
    ]) {
      await expect(checkDestination(url, { resolve: counting }), url).rejects.toBeInstanceOf(
        EgressError,
      );
    }
    expect(lookups).toBe(0);
  });

  it('reports a name that does not resolve', async () => {
    const none: Resolver = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    const empty: Resolver = async () => [];
    expect(await problemOf(checkDestination('https://nowhere.example', { resolve: none }))).toBe(
      'unresolvable',
    );
    expect(await problemOf(checkDestination('https://nowhere.example', { resolve: empty }))).toBe(
      'unresolvable',
    );
  });
});
