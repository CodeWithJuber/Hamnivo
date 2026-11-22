import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { Client, PASSWORD } from './harness.js';
import { totpFromUri } from './totp.js';

/**
 * Turns on two-step verification for a signed-in person and returns a new client signed in with
 * it (a session that passed MFA, with a fresh sign-in for step-up), in the same tenant.
 */
export async function withTwoStep(
  app: NestFastifyApplication,
  client: Client,
  email: string,
): Promise<Client> {
  const enabled = await client.post('/api/auth/two-factor/enable', { password: PASSWORD });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  const uri = enabled.body.totpURI as string;
  const verified = await client.post('/api/auth/two-factor/verify-totp', {
    code: totpFromUri(uri),
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const fresh = new Client(app);
  const first = await fresh.post('/api/auth/sign-in/email', { email, password: PASSWORD });
  expect(first.body.twoFactorRedirect).toBe(true);
  const second = await fresh.post('/api/auth/two-factor/verify-totp', { code: totpFromUri(uri) });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  fresh.tenant = client.tenant;
  return fresh;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type ReceiverAnswer = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Holds the answer until this settles: an endpoint slow to answer. */
  wait?: Promise<unknown>;
};

/**
 * A local HTTP endpoint for webhook deliveries: records every request and answers from a queue
 * (204 when the queue is empty).
 */
export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  private readonly answers: ReceiverAnswer[] = [];
  private server: Server | undefined;
  origin = '';

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const answer = this.answers.shift() ?? { status: 204 };
        void Promise.resolve(answer.wait).then(() => {
          response.writeHead(answer.status, answer.headers ?? {});
          response.end(answer.body ?? '');
        });
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  answer(...answers: ReceiverAnswer[]): void {
    this.answers.push(...answers);
  }

  /** Requests to one path, oldest first, with parsed bodies. */
  at(path: string): (ReceivedRequest & { json: Record<string, any> })[] {
    return this.requests
      .filter((request) => request.path === path)
      .map((request) => ({ ...request, json: JSON.parse(request.body || '{}') }));
  }

  reset(): void {
    this.requests.length = 0;
    this.answers.length = 0;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
