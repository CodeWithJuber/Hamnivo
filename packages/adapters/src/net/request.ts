import type { LookupAddress } from 'node:dns';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { addressBlock } from './address.js';
import {
  checkUrl,
  EgressError,
  type EgressPolicy,
  type ResolvedAddress,
  systemResolver,
} from './policy.js';

export interface EgressRequest {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Deadline for the whole exchange, redirects and reading the response included. */
  timeoutMs: number;
  /** Response bytes read at most; the rest is left unread (default 64 KiB). */
  maxResponseBytes?: number;
  /**
   * Redirects to follow (default 0: a 3xx response is returned as it is). Every hop is checked
   * like the first one, so a redirect never leads to a private address or a host off the list.
   */
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface EgressResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The response was longer than maxResponseBytes: only the first bytes were read. */
  truncated: boolean;
  durationMs: number;
  /** The address connected to (for diagnostics). */
  remoteAddress: string | null;
  /** The URL that answered, after any redirects. */
  url: string;
  redirects: number;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for node:net that resolves the host and refuses the connection when any address is
 * private. The check runs on the addresses the socket will actually use, so a host name that
 * resolved to a public address a moment ago and now points inside the network (DNS rebinding)
 * is still refused.
 */
export function guardedLookup(policy: EgressPolicy, trusted: boolean) {
  const resolve = policy.resolve ?? systemResolver;
  return (
    hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: LookupCallback,
  ): void => {
    resolve(hostname)
      .then((addresses: ResolvedAddress[]) => {
        if (addresses.length === 0) {
          throw new EgressError('unresolvable', 'The host name could not be resolved.');
        }
        if (!trusted && addresses.some((entry) => addressBlock(entry.address) !== null)) {
          throw new EgressError('private_address', 'The host name resolves to a private network.');
        }
        const family =
          options.family === 4 || options.family === 'IPv4'
            ? 4
            : options.family === 6 || options.family === 'IPv6'
              ? 6
              : 0;
        const usable = family ? addresses.filter((entry) => entry.family === family) : addresses;
        const first = usable[0];
        if (!first) throw new EgressError('unresolvable', 'No address of the requested family.');
        if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof EgressError
            ? error
            : new EgressError('unresolvable', 'The host name could not be resolved.', {
                cause: error,
              });
        callback(failure as NodeJS.ErrnoException, '', 0);
      });
  };
}

const TLS_CODES =
  /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/;

function classify(error: unknown, timedOut: boolean): EgressError {
  if (error instanceof EgressError) return error;
  if (timedOut) return new EgressError('timeout', 'The request timed out.', { cause: error });
  const code = String((error as { code?: unknown })?.code ?? '');
  if (TLS_CODES.test(code)) {
    return new EgressError('tls', 'The secure connection could not be established.', {
      cause: error,
    });
  }
  return new EgressError('network', 'The connection failed.', { cause: error });
}

interface Hop {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  remoteAddress: string | null;
}

function once(
  url: URL,
  trusted: boolean,
  input: EgressRequest,
  method: string,
  body: string | Buffer | undefined,
  policy: EgressPolicy,
  signal: AbortSignal,
): Promise<Hop> {
  const maxBytes = input.maxResponseBytes ?? 64 * 1024;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = send(
      url,
      {
        method,
        headers: {
          ...input.headers,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        // A fresh connection per request: no pooled socket outlives the address check.
        agent: false,
        signal,
        maxHeaderSize: 16 * 1024,
        // IP literals skip `lookup`; they were checked by checkUrl.
        ...(isIP(host) ? {} : { lookup: guardedLookup(policy, trusted) as never }),
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const remoteAddress = response.socket?.remoteAddress ?? null;
        const done = (truncated: boolean) =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
              truncated,
              remoteAddress,
            }),
          );
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = maxBytes - size;
          if (chunk.length <= room) {
            chunks.push(chunk);
            size += chunk.length;
            return;
          }
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          // Enough has been read: stop, and let nothing more come in.
          done(true);
          response.destroy();
          request.destroy();
        });
        response.on('end', () => done(false));
        response.on('error', (error) => finish(() => reject(error)));
        response.on('aborted', () => finish(() => reject(new Error('response aborted'))));
      },
    );
    request.on('error', (error) => finish(() => reject(error)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * Makes one outbound HTTP request under an egress policy: no private or reserved address (checked
 * on the address actually connected to, so DNS rebinding does not help), no redirect to one, a
 * deadline for the whole exchange and a cap on the response size.
 */
export async function safeRequest(
  input: EgressRequest,
  policy: EgressPolicy,
): Promise<EgressResponse> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(Math.max(1, input.timeoutMs));
  const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline;
  const maxRedirects = input.maxRedirects ?? 0;
  let target = checkUrl(input.url, policy);
  let method = input.method ?? (input.body !== undefined ? 'POST' : 'GET');
  let body = input.body;
  for (let redirects = 0; ; redirects += 1) {
    let hop: Hop;
    try {
      hop = await once(target.url, target.trusted, input, method, body, policy, signal);
    } catch (error) {
      throw classify(error, deadline.aborted);
    }
    const location = hop.headers.location;
    const isRedirect = hop.status >= 300 && hop.status < 400 && typeof location === 'string';
    if (!isRedirect || maxRedirects === 0) {
      return {
        ...hop,
        durationMs: Math.round(performance.now() - started),
        url: target.url.toString(),
        redirects,
      };
    }
    if (redirects >= maxRedirects) {
      throw new EgressError('too_many_redirects', 'The address redirected too many times.');
    }
    let next: URL;
    try {
      next = new URL(location, target.url);
    } catch {
      throw new EgressError('invalid_url', 'The address redirected to an invalid URL.');
    }
    // The next hop gets exactly the same checks: scheme, allowlist, private addresses.
    target = checkUrl(next, policy);
    if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }
}
