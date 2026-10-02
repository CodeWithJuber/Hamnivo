import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDestination,
  EgressError,
  type EgressPolicy,
  type Resolver,
  safeRequest,
} from '../../src/net/index.js';

interface Receiver {
  origin: string;
  port: number;
  hits: { method: string; url: string; body: string; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

const open: Receiver[] = [];

async function receiver(
  handler: (request: IncomingMessage, response: ServerResponse) => void = (_q, s) =>
    s.writeHead(204).end(),
): Promise<Receiver> {
  const hits: Receiver['hits'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
      });
      handler(request, response);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  const item: Receiver = {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
  open.push(item);
  return item;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
});

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error.problem;
    throw error;
  }
  return 'delivered';
}

const loopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];

describe('safeRequest', () => {
  it('delivers to a trusted origin and reports status, body and time', async () => {
    const target = await receiver((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const response = await safeRequest(
      {
        url: `${target.origin}/hook`,
        body: '{"type":"webhook.test"}',
        headers: { 'content-type': 'application/json', 'webhook-id': 'evt_1' },
        timeoutMs: 5000,
      },
      { trustedOrigins: [target.origin] },
    );
    expect(response).toMatchObject({
      status: 200,
      truncated: false,
      url: `${target.origin}/hook`,
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.body.toString()).toBe('ok');
    expect(target.hits).toEqual([
      expect.objectContaining({ method: 'POST', url: '/hook', body: '{"type":"webhook.test"}' }),
    ]);
    expect(target.hits[0]?.headers['webhook-id']).toBe('evt_1');
    expect(target.hits[0]?.headers['content-length']).toBe('23');
  });

  it('sends GET without a body, and the method it is given', async () => {
    const target = await receiver((_request, response) => {
      response.writeHead(200).end('here');
    });
    const policy = { trustedOrigins: [target.origin] };
    await safeRequest({ url: `${target.origin}/a`, timeoutMs: 5000 }, policy);
    await safeRequest(
      { url: `${target.origin}/b`, method: 'PUT', body: 'x', timeoutMs: 5000 },
      policy,
    );
    const head = await safeRequest(
      { url: `${target.origin}/c`, method: 'HEAD', timeoutMs: 5000 },
      policy,
    );
    expect(head.body.length).toBe(0);
    expect(target.hits.map((hit) => [hit.method, hit.url, hit.body])).toEqual([
      ['GET', '/a', ''],
      ['PUT', '/b', 'x'],
      ['HEAD', '/c', ''],
    ]);
  });

  it('reads at most the size limit of a response', async () => {
    const target = await receiver((_request, response) => {
      response.writeHead(200).end('x'.repeat(200_000));
    });
    const policy = { trustedOrigins: [target.origin] };
    const response = await safeRequest(
      { url: `${target.origin}/big`, timeoutMs: 5000, maxResponseBytes: 1024 },
      policy,
    );
    expect(response.body.length).toBe(1024);
    expect(response.truncated).toBe(true);
    // A body that fits is not truncated, even when it is exactly the limit.
    const exact = await safeRequest(
      { url: `${target.origin}/big`, timeoutMs: 5000, maxResponseBytes: 200_000 },
      policy,
    );
    expect(exact.body.length).toBe(200_000);
    expect(exact.truncated).toBe(false);
  });

  it('gives up at the deadline', async () => {
    const target = await receiver(() => {
      // Never answers.
    });
    const started = Date.now();
    const problem = await problemOf(
      safeRequest(
        { url: `${target.origin}/slow`, timeoutMs: 300 },
        { trustedOrigins: [target.origin] },
      ),
    );
    expect(problem).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('gives up at the deadline of a response that stops halfway', async () => {
    const target = await receiver((_request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('partial');
    });
    const problem = await problemOf(
      safeRequest(
        { url: `${target.origin}/stall`, timeoutMs: 400 },
        { trustedOrigins: [target.origin] },
      ),
    );
    expect(problem).toBe('timeout');
  });

  it('reports a connection that fails, and a secure connection that cannot be made', async () => {
    const target = await receiver();
    const closed = target.origin;
    await target.close();
    expect(
      await problemOf(
        safeRequest({ url: `${closed}/`, timeoutMs: 2000 }, { trustedOrigins: [closed] }),
      ),
    ).toBe('network');
    // TLS to a server that speaks plain HTTP.
    const plain = await receiver();
    const secure = `https://127.0.0.1:${plain.port}`;
    expect(
      await problemOf(
        safeRequest({ url: `${secure}/`, timeoutMs: 2000 }, { trustedOrigins: [secure] }),
      ),
    ).toBe('tls');
  });

  it('refuses a private address given directly, without connecting', async () => {
    const target = await receiver();
    const policy: EgressPolicy = {};
    expect(
      await problemOf(
        safeRequest({ url: `https://127.0.0.1:${target.port}/`, timeoutMs: 2000 }, policy),
      ),
    ).toBe('private_address');
    // Plain HTTP is refused first, for a public address and a private one alike.
    expect(
      await problemOf(safeRequest({ url: `${target.origin}/`, timeoutMs: 2000 }, policy)),
    ).toBe('insecure_url');
    expect(target.hits).toHaveLength(0);
  });

  it('refuses a host name that resolves to a private address, without connecting', async () => {
    const target = await receiver();
    const url = `https://receiver.example:${target.port}/hook`;
    const refused = (resolve: Resolver) =>
      problemOf(safeRequest({ url, timeoutMs: 2000, body: 'x' }, { resolve }));
    expect(await refused(loopback)).toBe('private_address');
    expect(await refused(async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).toBe(
      'private_address',
    );
    expect(
      await refused(async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).toBe('private_address');
    expect(target.hits).toHaveLength(0);
  });

  it('checks the address it connects to, so DNS rebinding after the check fails', async () => {
    const target = await receiver();
    let lookups = 0;
    // First answer public (the check when the endpoint is saved), then the internal address.
    const rebinding: Resolver = async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const policy: EgressPolicy = { resolve: rebinding };
    const url = `https://rebind.example:${target.port}/hook`;
    await checkDestination(url, policy);
    expect(await problemOf(safeRequest({ url, timeoutMs: 2000, body: 'x' }, policy))).toBe(
      'private_address',
    );
    expect(lookups).toBe(2);
    expect(target.hits).toHaveLength(0);
  });

  it('trusts an origin as a whole: its own address may be private, another port may not', async () => {
    const target = await receiver((_request, response) => response.writeHead(204).end());
    const named = `http://hooks.internal.example:${target.port}`;
    const policy: EgressPolicy = { trustedOrigins: [named], resolve: loopback };
    expect(await problemOf(safeRequest({ url: `${named}/ok`, timeoutMs: 2000 }, policy))).toBe(
      'delivered',
    );
    expect(target.hits).toHaveLength(1);
    // The same host on another port is another origin: refused, and nothing is sent.
    const other = await receiver();
    expect(
      await problemOf(
        safeRequest(
          { url: `https://hooks.internal.example:${other.port}/`, timeoutMs: 2000 },
          { ...policy, trustedOrigins: [named] },
        ),
      ),
    ).toBe('private_address');
    expect(other.hits).toHaveLength(0);
  });

  it('reports a name that does not resolve', async () => {
    const none: Resolver = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(
      await problemOf(
        safeRequest({ url: 'https://nowhere.example/', timeoutMs: 2000 }, { resolve: none }),
      ),
    ).toBe('unresolvable');
  });

  it('applies the allowlist before any lookup', async () => {
    let lookups = 0;
    const counting: Resolver = async () => {
      lookups += 1;
      return loopback('x');
    };
    const policy = { allowedHosts: ['hooks.example.com'], resolve: counting };
    expect(
      await problemOf(safeRequest({ url: 'https://elsewhere.example/', timeoutMs: 2000 }, policy)),
    ).toBe('host_not_allowed');
    expect(lookups).toBe(0);
  });

  describe('redirects', () => {
    it('are returned as they are and never followed, wherever they point', async () => {
      const inside = await receiver();
      const targets = [
        `${inside.origin}/steal`,
        'http://169.254.169.254/latest/meta-data/',
        'https://hooks.example.com/elsewhere',
        '/relative',
      ];
      for (const location of targets) {
        const entry = await receiver((_request, response) => {
          response.writeHead(307, { location }).end();
        });
        // Even where every origin is trusted, a redirect is not followed.
        const response = await safeRequest(
          { url: `${entry.origin}/hook`, body: 'x', timeoutMs: 2000 },
          { trustedOrigins: [entry.origin, inside.origin] },
        );
        expect(response, location).toMatchObject({
          status: 307,
          headers: { location },
          url: `${entry.origin}/hook`,
        });
        expect(entry.hits, location).toHaveLength(1);
      }
      expect(inside.hits).toHaveLength(0);
    });
  });
});
