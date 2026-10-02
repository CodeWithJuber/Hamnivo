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
  it('delivers to a trusted origin and reports status, body, time and address', async () => {
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
    expect(response).toMatchObject({ status: 200, truncated: false, redirects: 0 });
    expect(response.body.toString()).toBe('ok');
    expect(response.remoteAddress).toBe('127.0.0.1');
    expect(target.hits).toEqual([
      expect.objectContaining({ method: 'POST', url: '/hook', body: '{"type":"webhook.test"}' }),
    ]);
    expect(target.hits[0]?.headers['webhook-id']).toBe('evt_1');
  });

  it('reads at most the size limit of a response', async () => {
    const target = await receiver((_request, response) => {
      response.writeHead(200).end('x'.repeat(200_000));
    });
    const response = await safeRequest(
      { url: `${target.origin}/big`, timeoutMs: 5000, maxResponseBytes: 1024 },
      { trustedOrigins: [target.origin] },
    );
    expect(response.body.length).toBe(1024);
    expect(response.truncated).toBe(true);
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

  it('refuses a private address given directly, without connecting', async () => {
    const target = await receiver();
    const policy: EgressPolicy = { requireHttps: false };
    expect(
      await problemOf(safeRequest({ url: `${target.origin}/`, timeoutMs: 2000 }, policy)),
    ).toBe('private_address');
    expect(target.hits).toHaveLength(0);
  });

  it('refuses a host name that resolves to a private address, without connecting', async () => {
    const target = await receiver();
    const policy: EgressPolicy = { requireHttps: false, resolve: loopback };
    const url = `http://receiver.example:${target.port}/hook`;
    expect(await problemOf(safeRequest({ url, timeoutMs: 2000, body: 'x' }, policy))).toBe(
      'private_address',
    );
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
    const policy: EgressPolicy = { requireHttps: false, resolve: rebinding };
    const url = `http://rebind.example:${target.port}/hook`;
    await checkDestination(url, policy);
    expect(await problemOf(safeRequest({ url, timeoutMs: 2000, body: 'x' }, policy))).toBe(
      'private_address',
    );
    expect(lookups).toBe(2);
    expect(target.hits).toHaveLength(0);
  });

  describe('redirects', () => {
    it('returns a redirect as it is by default, without following it', async () => {
      const inside = await receiver();
      const entry = await receiver((_request, response) => {
        response.writeHead(302, { location: `${inside.origin}/steal` }).end();
      });
      const response = await safeRequest(
        { url: `${entry.origin}/hook`, body: 'x', timeoutMs: 2000 },
        { trustedOrigins: [entry.origin] },
      );
      expect(response.status).toBe(302);
      expect(inside.hits).toHaveLength(0);
    });

    it('never follows a redirect to a private address or a metadata service', async () => {
      const inside = await receiver();
      const targets = [`${inside.origin}/steal`, 'http://169.254.169.254/latest/meta-data/'];
      for (const location of targets) {
        const entry = await receiver((_request, response) => {
          response.writeHead(307, { location }).end();
        });
        const problem = await problemOf(
          safeRequest(
            { url: `${entry.origin}/hook`, body: 'x', timeoutMs: 2000, maxRedirects: 3 },
            { trustedOrigins: [entry.origin], requireHttps: false },
          ),
        );
        expect(problem, location).toBe('private_address');
      }
      expect(inside.hits).toHaveLength(0);
    });

    it('never follows a redirect to a name that resolves privately, nor off the allowlist', async () => {
      const inside = await receiver();
      const toName = await receiver((_request, response) => {
        response.writeHead(302, { location: `http://innocent.example:${inside.port}/` }).end();
      });
      expect(
        await problemOf(
          safeRequest(
            { url: `${toName.origin}/`, timeoutMs: 2000, maxRedirects: 2 },
            { trustedOrigins: [toName.origin], requireHttps: false, resolve: loopback },
          ),
        ),
      ).toBe('private_address');
      const offList = await receiver((_request, response) => {
        response.writeHead(302, { location: 'https://elsewhere.example/' }).end();
      });
      expect(
        await problemOf(
          safeRequest(
            { url: `${offList.origin}/`, timeoutMs: 2000, maxRedirects: 2 },
            { trustedOrigins: [offList.origin], allowedHosts: ['hooks.example.com'] },
          ),
        ),
      ).toBe('host_not_allowed');
      const insecure = await receiver((_request, response) => {
        response.writeHead(302, { location: 'http://hooks.example.com/' }).end();
      });
      expect(
        await problemOf(
          safeRequest(
            { url: `${insecure.origin}/`, timeoutMs: 2000, maxRedirects: 2 },
            { trustedOrigins: [insecure.origin] },
          ),
        ),
      ).toBe('insecure_url');
      expect(inside.hits).toHaveLength(0);
    });

    it('follows an allowed redirect, turning a POST into a GET on 302', async () => {
      const final = await receiver((_request, response) => response.writeHead(200).end('here'));
      const entry = await receiver((_request, response) => {
        response.writeHead(302, { location: `${final.origin}/moved` }).end();
      });
      const response = await safeRequest(
        { url: `${entry.origin}/hook`, body: 'x', timeoutMs: 2000, maxRedirects: 2 },
        { trustedOrigins: [entry.origin, final.origin] },
      );
      expect(response).toMatchObject({ status: 200, redirects: 1, url: `${final.origin}/moved` });
      expect(final.hits).toEqual([expect.objectContaining({ method: 'GET', url: '/moved' })]);
    });

    it('stops after the redirect limit', async () => {
      const loop = await receiver((_request, response) => {
        response.writeHead(302, { location: '/again' }).end();
      });
      expect(
        await problemOf(
          safeRequest(
            { url: `${loop.origin}/`, timeoutMs: 2000, maxRedirects: 2 },
            { trustedOrigins: [loop.origin] },
          ),
        ),
      ).toBe('too_many_redirects');
      expect(loop.hits).toHaveLength(3);
    });
  });
});
