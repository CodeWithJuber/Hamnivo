import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A customer's own web service for the tests of custom HTTP tools: a real server on a loopback
 * port that records every request it gets and answers from a table of routes, so what a tool
 * sends (the path, the query, the headers, the body) can be read back. The egress guard cannot be
 * intercepted by a request mock, so the test trusts this origin the way an administrator would.
 */

export interface FakeCall {
  method: string;
  /** The path and query as they were sent. */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  type?: string;
  headers?: Record<string, string>;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Drops the connection without answering. */
  drop?: boolean;
}

export type FakeRoute = (call: FakeCall) => FakeReply | Promise<FakeReply>;

export interface FakeApi {
  /** `http://127.0.0.1:port`. */
  origin: string;
  calls: FakeCall[];
  /** Answers the next calls to an exact route (`'POST /orders/1/notes'`) with these, once each. */
  queue(route: string, ...replies: FakeReply[]): void;
  /** The calls to routes that start with this (`'POST /orders'`). */
  callsTo(prefix: string): FakeCall[];
  close(): Promise<void>;
}

export async function startFakeApi(routes: Record<string, FakeRoute>): Promise<FakeApi> {
  const calls: FakeCall[] = [];
  const queued = new Map<string, FakeReply[]>();
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method = '', pattern = ''] = key.split(' ');
    return { method, regex: new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`), handler };
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const parsed = new URL(request.url ?? '/', 'http://fake.test');
    const call: FakeCall = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    calls.push(call);
    const route = table.find((r) => r.method === call.method && r.regex.test(call.path));
    const reply: FakeReply =
      queued.get(`${call.method} ${call.path}`)?.shift() ??
      (route ? await route.handler(call) : { status: 404, json: { error: 'no such route' } });
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (reply.drop) {
      request.socket.destroy();
      return;
    }
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
    const type = reply.type ?? (reply.json !== undefined ? 'application/json' : 'text/plain');
    response
      .writeHead(reply.status ?? 200, { 'content-type': type, ...(reply.headers ?? {}) })
      .end(reply.status === 204 ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    queue(route, ...replies) {
      queued.set(route, [...(queued.get(route) ?? []), ...replies]);
    },
    callsTo: (prefix) => calls.filter((call) => `${call.method} ${call.path}`.startsWith(prefix)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
