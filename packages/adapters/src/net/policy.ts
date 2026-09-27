import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { addressBlock } from './address.js';

/**
 * Egress policy (X05): where the server may send a request it makes for a tenant (a webhook, a
 * callback). Private and reserved addresses are always refused; the tenant may narrow the rest to
 * an allowlist of hosts; the server administrator may trust a few origins explicitly (a service
 * on the local network, or a test receiver), which are then reachable over plain HTTP too.
 */

export type EgressProblem =
  | 'invalid_url'
  | 'insecure_url'
  | 'host_not_allowed'
  | 'private_address'
  | 'unresolvable'
  | 'timeout'
  | 'network'
  | 'tls'
  | 'too_many_redirects';

/** A refused or failed outbound request. The message never contains response content. */
export class EgressError extends Error {
  override name = 'EgressError';
  constructor(
    readonly problem: EgressProblem,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it has (injectable, e.g. to test DNS rebinding). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressPolicy {
  /**
   * The tenant's allowlist: exact hosts (`hooks.example.com`) or a wildcard for subdomains
   * (`*.example.com`, which does not include `example.com` itself). Empty: any public host.
   */
  allowedHosts?: readonly string[];
  /**
   * Origins the server administrator trusts (`http://10.0.0.5:8080`): reachable even on a private
   * network and over plain HTTP. Never set from tenant input.
   */
  trustedOrigins?: readonly string[];
  /** Plain HTTP is refused except for trusted origins (default true). */
  requireHttps?: boolean;
  /** Host name resolution; the system resolver by default. */
  resolve?: Resolver;
}

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

/** Host names that name the local machine or network, whatever DNS says. */
const LOCAL_NAMES =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lower case, without brackets or a trailing dot: how hosts are compared. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Validates one allowlist entry and returns it normalized: a host name with at least two labels,
 * optionally starting with `*.`, or an IP address. Returns null when it is not acceptable.
 */
export function normalizeHostPattern(pattern: string): string | null {
  const value = normalizeHost(pattern);
  if (value.length === 0 || value.length > 253) return null;
  if (isIP(value)) return addressBlock(value) === null ? value : null;
  const wildcard = value.startsWith('*.');
  const name = wildcard ? value.slice(2) : value;
  let ascii: string;
  try {
    ascii = new URL(`http://${name}`).hostname;
  } catch {
    return null;
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels.at(-1) ?? '')) return null;
  if (LOCAL_NAMES.test(ascii)) return null;
  return wildcard ? `*.${ascii}` : ascii;
}

/** Whether `host` is on the allowlist (an empty allowlist allows every public host). */
export function hostAllowed(host: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  const value = normalizeHost(host);
  return patterns.some((raw) => {
    const pattern = normalizeHost(raw);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return value.endsWith(suffix) && value.length > suffix.length;
    }
    return value === pattern;
  });
}

export interface Destination {
  url: URL;
  /** The server administrator trusts this origin: private addresses and plain HTTP allowed. */
  trusted: boolean;
}

/**
 * Checks a URL without contacting it: syntax, scheme, the host name and the tenant allowlist,
 * and for an IP literal that it is public. Host names are checked again at connection time,
 * against the address actually used (see safeRequest).
 */
export function checkUrl(input: string | URL, policy: EgressPolicy): Destination {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new EgressError('invalid_url', 'The address is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EgressError('invalid_url', 'Only http and https addresses can be called.');
  }
  if (url.username || url.password) {
    throw new EgressError('invalid_url', 'The address must not contain a user name or password.');
  }
  if (policy.trustedOrigins?.includes(url.origin)) return { url, trusted: true };
  if (url.protocol !== 'https:' && policy.requireHttps !== false) {
    throw new EgressError('insecure_url', 'The address must use HTTPS.');
  }
  const host = normalizeHost(url.hostname);
  if (isIP(host)) {
    if (addressBlock(host) !== null) {
      throw new EgressError('private_address', 'The address points to a private network.');
    }
  } else {
    if (!host.includes('.') || LOCAL_NAMES.test(host)) {
      throw new EgressError('private_address', 'The address points to a local host name.');
    }
  }
  if (!hostAllowed(host, policy.allowedHosts)) {
    throw new EgressError(
      'host_not_allowed',
      "The host is not on this workspace's list of allowed hosts.",
    );
  }
  return { url, trusted: false };
}

/**
 * Checks a URL and resolves its host now, so a person setting it up hears at once that it points
 * to a private network. Advisory only: DNS can change before a request, which is why every
 * connection checks its own address again.
 */
export async function checkDestination(
  input: string | URL,
  policy: EgressPolicy,
): Promise<Destination> {
  const destination = checkUrl(input, policy);
  const host = normalizeHost(destination.url.hostname);
  if (destination.trusted || isIP(host)) return destination;
  let addresses: ResolvedAddress[];
  try {
    addresses = await (policy.resolve ?? systemResolver)(host);
  } catch (error) {
    throw new EgressError('unresolvable', 'The host name could not be resolved.', {
      cause: error,
    });
  }
  if (addresses.length === 0) {
    throw new EgressError('unresolvable', 'The host name could not be resolved.');
  }
  if (addresses.some((entry) => addressBlock(entry.address) !== null)) {
    throw new EgressError('private_address', 'The host name resolves to a private network.');
  }
  return destination;
}
