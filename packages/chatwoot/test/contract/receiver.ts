import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  port: number;
  received: Received[];
  /** Resolves with the matching deliveries once `count` have arrived. */
  waitFor(
    predicate: (r: Received) => boolean,
    count?: number,
    timeoutMs?: number,
  ): Promise<Received[]>;
  close(): Promise<void>;
}

/** A webhook endpoint that records every delivery (reachable from Docker when bound to 0.0.0.0). */
export async function startReceiver(host = '127.0.0.1'): Promise<Receiver> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    async waitFor(predicate, count = 1, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const matches = received.filter(predicate);
        if (matches.length >= count) return matches;
        if (Date.now() > deadline) {
          throw new Error(
            `Expected ${count} matching webhook(s), got ${matches.length} of ${received.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
