import { readFileSync } from 'node:fs';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/** A request a provider SDK sent, as the provider would have received it. */
export interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: any;
}

export type Responder = (request: Request, index: number) => Response | Promise<Response>;

/**
 * Starts msw for the calling test file. Every request is answered by the current responder and
 * recorded, so no test can reach a real provider.
 */
export function interceptProviders() {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return {
    /** Answers the next requests with `respond` (or with each responder in turn). */
    reply(...responders: Responder[]): Captured[] {
      const captured: Captured[] = [];
      server.use(
        http.all('*', async ({ request }) => {
          const text = await request.clone().text();
          const index = captured.length;
          captured.push({
            url: new URL(request.url),
            method: request.method,
            headers: request.headers,
            body: text ? JSON.parse(text) : undefined,
          });
          const respond = responders[Math.min(index, responders.length - 1)] as Responder;
          return respond(request, index);
        }),
      );
      return captured;
    },
  };
}

export const fixtureText = (provider: string, file: string) =>
  readFileSync(new URL(`./fixtures/${provider}/${file}`, import.meta.url), 'utf8');

export const fixtureJson = (provider: string, file: string): any =>
  JSON.parse(fixtureText(provider, file));

export const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Responder =>
  () =>
    HttpResponse.json(body as JsonBodyType, { status, headers });

/** Sends a server-sent events body one event per chunk, as a provider would. */
export const sse =
  (text: string): Responder =>
  () => {
    const encoder = new TextEncoder();
    const events = text.split(/(?<=\n\n)/);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
  };

export async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const parts: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

export const textDeltas = (parts: LanguageModelV4StreamPart[]) =>
  parts.flatMap((part) => (part.type === 'text-delta' && part.delta !== '' ? [part.delta] : []));

/** The rejection of `promise`; fails the test when it resolves. */
export async function failure(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail');
}
