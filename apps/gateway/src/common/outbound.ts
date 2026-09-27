import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Requests the server makes on a tenant's behalf (an identity provider's discovery document, its
 * keys). A tenant must never be able to point the server at a private address: loopback, the
 * cloud metadata service, the local network. Only HTTPS to publicly routable addresses is allowed,
 * plus origins the server administrator trusts explicitly (a private identity provider).
 */

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is publicly routable (IPv4-mapped IPv6 is judged by its IPv4). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !PRIVATE.check(address, 'ipv6');
  }
  return false;
}

export type OutboundProblem = 'invalid_url' | 'insecure_url' | 'private_host' | 'unresolvable';

export class OutboundUrlError extends Error {
  override name = 'OutboundUrlError';
  constructor(
    readonly problem: OutboundProblem,
    readonly url: string,
  ) {
    super(`${problem}: ${url}`);
  }
}

export interface OutboundPolicy {
  /** Origins the server administrator trusts even on a private network (plain HTTP allowed). */
  trustedOrigins: readonly string[];
  /** Resolves a host name to addresses (injectable for tests). */
  resolve?: (host: string) => Promise<string[]>;
}

const systemResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Checks a URL before the server fetches it for a tenant. Returns the parsed URL. */
export async function assertFetchable(url: string, policy: OutboundPolicy): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OutboundUrlError('invalid_url', url);
  }
  if (parsed.username || parsed.password) throw new OutboundUrlError('invalid_url', url);
  if (policy.trustedOrigins.includes(parsed.origin)) return parsed;
  if (parsed.protocol !== 'https:') throw new OutboundUrlError('insecure_url', url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new OutboundUrlError('private_host', url);
    return parsed;
  }
  if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host)) {
    throw new OutboundUrlError('private_host', url);
  }
  let addresses: string[];
  try {
    addresses = await (policy.resolve ?? systemResolve)(host);
  } catch {
    throw new OutboundUrlError('unresolvable', url);
  }
  if (addresses.length === 0) throw new OutboundUrlError('unresolvable', url);
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new OutboundUrlError('private_host', url);
  }
  return parsed;
}

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
 * address), a time limit and a size limit.
 */
export async function fetchJson(
  url: string,
  policy: OutboundPolicy,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const target = await assertFetchable(url, policy);
  const maxBytes = options.maxBytes ?? 256 * 1024;
  let response: Response;
  try {
    response = await fetch(target, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    throw new OutboundResponseError(timeout ? 'timeout' : 'network');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new OutboundResponseError('redirect', response.status);
  }
  if (!response.ok) throw new OutboundResponseError('status', response.status);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = reader ? await reader.read() : { done: true as const, value: undefined };
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) {
      await reader?.cancel();
      throw new OutboundResponseError('too_large');
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OutboundResponseError('not_json');
  }
}
