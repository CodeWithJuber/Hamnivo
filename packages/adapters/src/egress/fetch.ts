import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress } from './address.js';

/**
 * SSRF-safe egress for tool calls (X05, blueprint §15 and §24). A request goes out only when
 *   - it uses HTTPS (plain HTTP only where private addresses are allowed: development and tests),
 *   - its host is on the tenant's allowlist for this tool (exact, or `*.example.com`),
 *   - every address the host resolves to is public; the check runs inside the socket's own DNS
 *     lookup, so the address that is checked is the address that is connected to (no rebinding),
 *   - redirects are not followed, and the response body stops at a size limit.
 * Failures say why in safe words and never include the response.
 */

export type EgressRefusal =
  | 'protocol'
  | 'host_not_allowed'
  | 'private_address'
  | 'dns_failed'
  | 'redirect'
  | 'response_too_large';

export class EgressError extends Error {
  override readonly name = 'EgressError';
  constructor(
    readonly reason: EgressRefusal,
    message: string,
  ) {
    super(message);
  }
}

export interface EgressPolicy {
  /** Hosts the request may reach: `orders.example.com` or `*.example.com`. */
  allowedHosts: readonly string[];
  /** Development and tests only: plain HTTP and private (loopback) addresses. */
  allowPrivate?: boolean;
  /** Response body ceiling in bytes (default 1 MiB). */
  maxResponseBytes?: number;
  /** DNS lookup (tests replace it). */
  lookup?: typeof dnsLookup;
}

const normalizeHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

/** Whether `host` is on the allowlist (`*.example.com` covers subdomains, not the domain itself). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = normalizeHost(host);
  return allowed.some((entry) => {
    const rule = normalizeHost(entry);
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      return name.endsWith(suffix) && name.length > suffix.length;
    }
    return name === rule;
  });
}

/** Checks the URL before any network activity. */
export function checkEgressUrl(url: URL, policy: EgressPolicy): void {
  if (url.protocol !== 'https:' && !(policy.allowPrivate && url.protocol === 'http:')) {
    throw new EgressError('protocol', 'Only HTTPS addresses can be reached.');
  }
  if (url.username || url.password) {
    throw new EgressError('protocol', 'Addresses with credentials are not allowed.');
  }
  if (!hostAllowed(url.hostname, policy.allowedHosts)) {
    throw new EgressError('host_not_allowed', 'This host is not on the allowlist for the tool.');
  }
  const literal = normalizeHost(url.hostname);
  if (isIP(literal) && !policy.allowPrivate && !isPublicAddress(literal)) {
    throw new EgressError('private_address', 'Private and internal addresses cannot be reached.');
  }
}

/** A DNS lookup that refuses any non-public answer (unless private addresses are allowed). */
function guardedLookup(policy: EgressPolicy): LookupFunction {
  const resolve = policy.lookup ?? dnsLookup;
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, found) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses = (Array.isArray(found) ? found : []) as LookupAddress[];
      if (addresses.length === 0) {
        callback(new EgressError('dns_failed', 'The host has no address.'), '', 0);
        return;
      }
      if (!policy.allowPrivate && addresses.some((a) => !isPublicAddress(a.address))) {
        callback(
          new EgressError('private_address', 'Private and internal addresses cannot be reached.'),
          '',
          0,
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, all: LookupAddress[]) => void)(null, addresses);
        return;
      }
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function bodyOf(init: RequestInit | undefined): Promise<Buffer | null> {
  const body = init?.body;
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(
    await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
  );
}

/** Caps a response stream; reading past the limit fails the body with response_too_large. */
function capped(source: IncomingMessage, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const web = Readable.toWeb(source) as ReadableStream<Uint8Array>;
  return web.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          source.destroy();
          controller.error(new EgressError('response_too_large', 'The response was too large.'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** A `fetch` that only reaches what the policy allows. */
export function guardedFetch(policy: EgressPolicy): typeof globalThis.fetch {
  const limit = policy.maxResponseBytes ?? 1_048_576;
  const lookup = guardedLookup(policy);
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    checkEgressUrl(url, policy);
    const body = await bodyOf(init);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const options: RequestOptions = {
      method: init?.method ?? 'GET',
      headers: {
        ...headersOf(init),
        ...(body ? { 'content-length': String(body.byteLength) } : {}),
      },
      lookup,
      ...(signal ? { signal } : {}),
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = send(url, options, resolve);
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    const status = response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      response.destroy();
      throw new EgressError('redirect', 'Redirects are not followed.');
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }
    const nullBody =
      status === 204 || status === 205 || status === 304 || options.method === 'HEAD';
    if (nullBody) response.resume();
    return new Response(nullBody ? null : capped(response, limit), {
      status,
      statusText: response.statusMessage ?? '',
      headers,
    });
  };
  return fetcher as typeof globalThis.fetch;
}
