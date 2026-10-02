import { fetch as undiciFetch } from 'undici';
import { guardedDispatcher } from './dispatcher.js';
import { checkUrl, EgressError, type EgressPolicy, refusalOf } from './policy.js';

export interface GuardedFetchOptions {
  /**
   * Response bytes read at most. Reading past the limit fails the body with a
   * `response_too_large` EgressError (default: no limit).
   */
  maxResponseBytes?: number;
  /**
   * What a redirect (3xx) response does. By default it is returned as it is, never followed, and
   * the caller decides; with this set it is refused with a `redirect` EgressError.
   */
  refuseRedirects?: boolean;
}

/** A `fetch` that only reaches what the policy allows; `close` ends the connections it opened. */
export type GuardedFetch = typeof globalThis.fetch & { close(): Promise<void> };

/** Where a call goes and with what: a Request is read out, and `init` overrides it. */
async function describe(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === 'string' || input instanceof URL) {
    return { url: String(input), init: init ?? {} };
  }
  const method = init?.method ?? input.method;
  const carried: RequestInit = {
    method,
    headers: input.headers,
    signal: input.signal,
    ...(input.body && method !== 'GET' && method !== 'HEAD'
      ? { body: await input.arrayBuffer() }
      : {}),
  };
  return { url: input.url, init: { ...carried, ...init } };
}

/** Caps a response body: reading past the limit fails with `response_too_large`. */
function capped(response: Response, limit: number): Response {
  if (!response.body) return response;
  let seen = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(new EgressError('response_too_large', 'The response was too large.'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A `fetch` for SDKs and clients that take one (MCP, migration sources, tenant model servers):
 * every address is checked by the policy before the request (`checkUrl`) and again by the
 * connection guard when it connects (`guardedDispatcher`), so a name that turns private after the
 * check is refused. Redirects are never followed. A refusal rejects with an EgressError; any
 * other failure rejects as `fetch` does.
 */
export function guardedFetch(
  policy: EgressPolicy,
  options: GuardedFetchOptions = {},
): GuardedFetch {
  const dispatcher = guardedDispatcher(policy);
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = await describe(input, init);
    checkUrl(request.url, policy);
    request.init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = (await undiciFetch(request.url, {
        ...request.init,
        redirect: 'manual',
        dispatcher,
      } as never)) as unknown as Response;
    } catch (error) {
      throw refusalOf(error) ?? error;
    }
    if (options.refuseRedirects && response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new EgressError('redirect', 'Redirects are not followed.');
    }
    return options.maxResponseBytes === undefined
      ? response
      : capped(response, options.maxResponseBytes);
  };
  return Object.assign(fetcher, { close: () => dispatcher.destroy() }) as GuardedFetch;
}
