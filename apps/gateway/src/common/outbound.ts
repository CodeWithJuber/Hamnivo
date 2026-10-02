import {
  checkDestination,
  EgressError,
  type EgressPolicy,
  safeRequest,
} from '@hamnivo/adapters/net';

/**
 * Reads a small JSON document a tenant points the server at (an identity provider's discovery
 * document). Which addresses may be reached is not decided here: every request made on a tenant's
 * behalf goes through the one egress guard in `@hamnivo/adapters/net` (HTTPS, public addresses
 * only, checked again for every connection, plus the origins the server administrator trusts).
 */

export class OutboundResponseError extends Error {
  override name = 'OutboundResponseError';
  constructor(
    readonly problem: 'status' | 'redirect' | 'too_large' | 'not_json' | 'timeout' | 'network',
    readonly status?: number,
  ) {
    super(problem);
  }
}

/**
 * GETs a small JSON document from a checked URL: no redirects (a redirect could lead to a private
 * address), a time limit and a size limit. A URL the guard refuses rejects with its EgressError;
 * a response that cannot be used rejects with an OutboundResponseError.
 */
export async function fetchJson(
  url: string,
  policy: EgressPolicy,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  await checkDestination(url, policy);
  let response: Awaited<ReturnType<typeof safeRequest>>;
  try {
    response = await safeRequest(
      {
        url,
        headers: { accept: 'application/json' },
        timeoutMs: options.timeoutMs ?? 5000,
        maxResponseBytes: options.maxBytes ?? 256 * 1024,
      },
      policy,
    );
  } catch (error) {
    if (error instanceof EgressError) {
      if (error.problem === 'timeout') throw new OutboundResponseError('timeout');
      if (error.problem === 'network' || error.problem === 'tls') {
        throw new OutboundResponseError('network');
      }
    }
    throw error;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OutboundResponseError('redirect', response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new OutboundResponseError('status', response.status);
  }
  if (response.truncated) throw new OutboundResponseError('too_large');
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new OutboundResponseError('not_json');
  }
}
