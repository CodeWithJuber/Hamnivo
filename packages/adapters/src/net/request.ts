import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { guardedDispatcher } from './dispatcher.js';
import { checkUrl, EgressError, type EgressPolicy, refusalOf } from './policy.js';

export interface EgressRequest {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Deadline for the whole exchange, reading the response included. */
  timeoutMs: number;
  /** Response bytes read at most; the rest is left unread (default 64 KiB). */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface EgressResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The response was longer than maxResponseBytes: only the first bytes were read. */
  truncated: boolean;
  durationMs: number;
  /** The URL that answered. A redirect is returned as it is, never followed. */
  url: string;
}

const TLS_CODES =
  /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/;
const TIMEOUT_CODES = /^(UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ETIMEDOUT)$/;

/** The first error code along the cause chain (Node and undici put it on the innermost error). */
function codeOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

function classify(error: unknown, timedOut: boolean): EgressError {
  const refusal = refusalOf(error);
  if (refusal) return refusal;
  const code = codeOf(error);
  if (timedOut || TIMEOUT_CODES.test(code)) {
    return new EgressError('timeout', 'The request timed out.', { cause: error });
  }
  if (TLS_CODES.test(code)) {
    return new EgressError('tls', 'The secure connection could not be established.', {
      cause: error,
    });
  }
  return new EgressError('network', 'The connection failed.', { cause: error });
}

/** Reads at most `limit` bytes; once there is more, the rest is dropped with the connection. */
async function readLimited(
  body: Readable,
  limit: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const room = limit - size;
    if (part.length <= room) {
      chunks.push(part);
      size += part.length;
      continue;
    }
    chunks.push(part.subarray(0, room));
    body.destroy();
    return { bytes: Buffer.concat(chunks), truncated: true };
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

/**
 * Makes one outbound HTTP request under an egress policy: https only, no private or reserved
 * address (checked when the connection is made, so DNS rebinding does not help), a redirect is
 * returned and never followed, a deadline for the whole exchange and a cap on the response size.
 * A fresh connection per request: nothing pooled outlives the address check.
 */
export async function safeRequest(
  input: EgressRequest,
  policy: EgressPolicy,
): Promise<EgressResponse> {
  const started = performance.now();
  const target = checkUrl(input.url, policy);
  const deadline = AbortSignal.timeout(Math.max(1, input.timeoutMs));
  const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline;
  const dispatcher = guardedDispatcher(policy);
  try {
    const response = await undiciRequest(target.url, {
      dispatcher,
      method: input.method ?? (input.body !== undefined ? 'POST' : 'GET'),
      headers: input.headers ?? {},
      ...(input.body !== undefined ? { body: input.body } : {}),
      signal,
      reset: true,
    });
    const { bytes, truncated } = await readLimited(
      response.body,
      input.maxResponseBytes ?? 64 * 1024,
    );
    return {
      status: response.statusCode,
      headers: response.headers,
      body: bytes,
      truncated,
      durationMs: Math.round(performance.now() - started),
      url: target.url.toString(),
    };
  } catch (error) {
    throw classify(error, deadline.aborted);
  } finally {
    await dispatcher.destroy().catch(() => undefined);
  }
}
