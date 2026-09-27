import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from './generated/chatwoot.js';

export type ChatwootClient = Client<paths>;

/** A failed Chatwoot call. 429 and 5xx are retryable; other statuses are not. */
export class ChatwootError extends Error {
  override name = 'ChatwootError';
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Chatwoot ${operation} failed with HTTP ${status}`);
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Platform App token or a user/bot access token (header `api_access_token`). */
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Typed client for Chatwoot's Platform, Application and Client (public) APIs. */
export function createChatwootClient(options: ClientOptions): ChatwootClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const middleware: Middleware = {
    onRequest({ request }) {
      request.headers.set('api_access_token', options.token);
      return new Request(request, { signal: AbortSignal.timeout(timeoutMs) });
    },
  };
  client.use(middleware);
  return client;
}

/** Returns the data of an openapi-fetch result or throws a ChatwootError. */
export async function call<T>(
  operation: string,
  pending: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await pending;
  } catch (error) {
    throw new ChatwootError(operation, 0, error instanceof Error ? error.message : String(error));
  }
  if (!result.response.ok || result.error !== undefined) {
    throw new ChatwootError(operation, result.response.status, result.error);
  }
  return result.data as T;
}
