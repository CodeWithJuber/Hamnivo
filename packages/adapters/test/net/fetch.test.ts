import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDestination,
  EgressError,
  type EgressPolicy,
  guardedDispatcher,
  guardedFetch,
  type Resolver,
} from '../../src/net/index.js';

let server: Server;
let port = 0;
let origin = '';
const requests: {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage['headers'];
}[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(5000));
      } else if (req.url === '/empty') {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: true, method: req.method, body: Buffer.concat(chunks).toString() }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A resolver that answers every name with the given addresses. */
const resolves =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error.problem;
    throw error;
  }
  return 'delivered';
}

describe('guardedFetch', () => {
  it('refuses a public name that resolves to an internal address (DNS rebinding)', async () => {
    const before = requests.length;
    const metadata = guardedFetch({ resolve: resolves('169.254.169.254') });
    expect(await refusal(metadata(`https://metadata.attacker.example:${port}/latest`))).toBe(
      'private_address',
    );
    const mixed = guardedFetch({ resolve: resolves('93.184.216.34', '10.0.0.1') });
    expect(await refusal(mixed(`https://mixed.attacker.example:${port}/`))).toBe('private_address');
    const mapped = guardedFetch({ resolve: resolves('::ffff:127.0.0.1') });
    expect(await refusal(mapped(`https://mapped.attacker.example:${port}/`))).toBe(
      'private_address',
    );
    expect(requests.length).toBe(before);
  });

  it('checks the address when it connects, not only when the URL is checked', async () => {
    let lookups = 0;
    const rebinding: Resolver = async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const policy: EgressPolicy = { resolve: rebinding };
    const url = `https://rebind.example:${port}/hook`;
    // The check when a person saves the address: public.
    await checkDestination(url, policy);
    // The connection a moment later: private.
    const before = requests.length;
    expect(await refusal(guardedFetch(policy)(url))).toBe('private_address');
    expect(lookups).toBe(2);
    expect(requests.length).toBe(before);
  });

  it('reaches a trusted origin, over plain HTTP and on a private address', async () => {
    const fetch = guardedFetch({ trustedOrigins: [origin] });
    const response = await fetch(`${origin}/ok`, { method: 'POST', body: '{"a":1}' });
    expect(await response.json()).toEqual({ ok: true, method: 'POST', body: '{"a":1}' });
    // Trust is for the exact origin: this port on another host name is not trusted.
    const named = guardedFetch({ trustedOrigins: [origin], resolve: resolves('127.0.0.1') });
    expect(await refusal(named(`https://trusted-looking.example:${port}/`))).toBe(
      'private_address',
    );
    // The same host on another port is another origin.
    expect(await refusal(fetch(`http://127.0.0.1:${port + 1}/`))).toBe('insecure_url');
  });

  it('reaches a trusted name on a private address, with the resolver it is given', async () => {
    const policy: EgressPolicy = {
      trustedOrigins: [`http://idp.corp.internal:${port}`],
      resolve: resolves('127.0.0.1'),
    };
    const response = await guardedFetch(policy)(`http://idp.corp.internal:${port}/ok`);
    expect(response.status).toBe(200);
  });

  it('refuses plain HTTP, credentials, hosts off the list and private literals before connecting', async () => {
    const before = requests.length;
    const fetch = guardedFetch({ allowedHosts: ['orders.example.com', '10.0.0.5'] });
    expect(await refusal(fetch(`${origin}/ok`))).toBe('insecure_url');
    expect(await refusal(fetch('http://orders.example.com/mcp'))).toBe('insecure_url');
    expect(await refusal(fetch('https://user:pw@orders.example.com/mcp'))).toBe('invalid_url');
    expect(await refusal(fetch('https://other.example.com/mcp'))).toBe('host_not_allowed');
    expect(await refusal(fetch('https://10.0.0.5/mcp'))).toBe('private_address');
    expect(await refusal(fetch('https://[::1]/mcp'))).toBe('private_address');
    expect(await refusal(fetch('not a url'))).toBe('invalid_url');
    expect(requests.length).toBe(before);
  });

  it('never follows a redirect: it returns it, or refuses it', async () => {
    const policy: EgressPolicy = { trustedOrigins: [origin] };
    const returned = await guardedFetch(policy)(`${origin}/redirect`);
    expect(returned.status).toBe(302);
    expect(returned.headers.get('location')).toBe('http://169.254.169.254/latest');
    const refused = guardedFetch(policy, { refuseRedirects: true });
    expect(await refusal(refused(`${origin}/redirect`))).toBe('redirect');
    // Nothing but the two requests above reached the server.
    expect(requests.filter((r) => r.url === '/redirect')).toHaveLength(2);
  });

  it('stops a body that grows past the limit, and lets one that fits through', async () => {
    const policy: EgressPolicy = { trustedOrigins: [origin] };
    const limited = guardedFetch(policy, { maxResponseBytes: 1000 });
    const big = await limited(`${origin}/big`);
    await expect(big.text()).rejects.toMatchObject({ problem: 'response_too_large' });
    const small = await guardedFetch(policy, { maxResponseBytes: 5000 })(`${origin}/big`);
    expect((await small.text()).length).toBe(5000);
    // A response without a body needs no cap.
    expect((await limited(`${origin}/empty`)).status).toBe(204);
  });

  it('takes a Request, with init overriding it, and an abort signal', async () => {
    const fetch = guardedFetch({ trustedOrigins: [origin] });
    const response = await fetch(
      new Request(`${origin}/ok`, {
        method: 'POST',
        body: 'from the request',
        headers: { 'x-a': '1' },
      }),
    );
    expect(await response.json()).toMatchObject({ method: 'POST', body: 'from the request' });
    expect(requests.at(-1)?.headers['x-a']).toBe('1');
    const overridden = await fetch(new Request(`${origin}/ok`), {
      method: 'PUT',
      body: 'init wins',
    });
    expect(await overridden.json()).toMatchObject({ method: 'PUT', body: 'init wins' });
    const controller = new AbortController();
    controller.abort();
    await expect(fetch(`${origin}/ok`, { signal: controller.signal })).rejects.toThrow();
  });

  it('lets other failures through as fetch reports them, and closes', async () => {
    const closed = `http://127.0.0.1:1`;
    const fetch = guardedFetch({ trustedOrigins: [closed] });
    await expect(fetch(`${closed}/`)).rejects.toThrow(TypeError);
    await fetch.close();
  });
});

describe('guardedDispatcher', () => {
  it('judges an IP literal itself, for a caller that gives it a URL nobody checked', async () => {
    const before = requests.length;
    const dispatcher = guardedDispatcher({});
    try {
      for (const target of [`http://127.0.0.1:${port}/ok`, `http://[::ffff:7f00:1]:${port}/ok`]) {
        const error = await undiciFetch(target, { dispatcher }).catch((e: unknown) => e);
        expect((error as Error).cause).toBeInstanceOf(EgressError);
        expect((error as { cause: EgressError }).cause.problem).toBe('private_address');
      }
      expect(requests.length).toBe(before);
    } finally {
      await dispatcher.destroy();
    }
  });

  it('refuses a name that resolves privately, whatever URL check came before', async () => {
    const before = requests.length;
    const dispatcher = guardedDispatcher({ resolve: resolves('127.0.0.1') });
    try {
      const error = await undiciFetch(`http://name.example:${port}/ok`, { dispatcher }).catch(
        (e: unknown) => e,
      );
      expect((error as { cause: EgressError }).cause).toMatchObject({ problem: 'private_address' });
      expect(requests.length).toBe(before);
    } finally {
      await dispatcher.destroy();
    }
  });
});
