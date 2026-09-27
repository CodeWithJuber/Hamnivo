import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Guards requests to a source system a staff member names by URL (the Chatwoot migration source,
 * M04): only http(s), no credentials in the URL, and never an address inside the network Hamnivo
 * runs in (loopback, private, link-local, metadata endpoints, carrier NAT, multicast). The check is
 * made when the URL is given and again for every connection, so a name that later resolves to an
 * internal address (DNS rebinding) is refused too. Redirects are never followed.
 */

export class SourceUrlError extends Error {
  override name = 'SourceUrlError';
  constructor(
    readonly code: 'invalid_url' | 'insecure_url' | 'private_address' | 'unresolved',
    message: string,
  ) {
    super(message);
  }
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)
    ? parts
    : null;
}

function publicIpv4(address: string): boolean {
  const p = ipv4Parts(address);
  if (!p) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0) return false; // IETF protocol assignments, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // documentation
  if (a === 203 && b === 0) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0] ?? '';
  // An embedded IPv4 tail (::ffff:10.0.0.1) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const parts = ipv4Parts(v4[1]);
    if (!parts) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (text.includes('::') ? left.length + right.length > 7 : left.length !== 8) return null;
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => '0'),
    ...right,
  ].map((g) => Number.parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

function publicIpv6(address: string): boolean {
  const g = expandIpv6(address);
  if (!g) return false;
  const first = g[0] as number;
  if (g.every((x) => x === 0)) return false; // unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // loopback
  // IPv4-mapped and IPv4-compatible addresses: judge the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const hi = g[6] as number;
    const lo = g[7] as number;
    return publicIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (first === 0x64 && g[1] === 0xff9b) return false; // NAT64 (to internal IPv4)
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80) return false; // link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

/** An address on the public internet (not loopback, private, link-local, reserved…). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

function lookupAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });
}

/**
 * Checks a source URL a person typed in and returns its origin (path, query and fragment are
 * dropped). `allowPrivate` is for development and tests against a local Chatwoot.
 */
export async function checkSourceUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceUrlError('invalid_url', 'The address is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new SourceUrlError('insecure_url', 'The address must start with https://.');
  }
  if (url.username || url.password) {
    throw new SourceUrlError(
      'invalid_url',
      'The address must not contain a user name or password.',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (isIP(host)) {
      if (!isPublicAddress(host)) {
        throw new SourceUrlError('private_address', 'The address points inside a private network.');
      }
    } else {
      let addresses: LookupAddress[];
      try {
        addresses = await lookupAll(host);
      } catch {
        throw new SourceUrlError('unresolved', 'The address could not be found.');
      }
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        throw new SourceUrlError('private_address', 'The address points inside a private network.');
      }
    }
  }
  return new URL(url.origin);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A fetch for source systems: every connection is checked, and redirects are not followed. */
export function guardedFetch(allowPrivate: boolean): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup(hostname: string, options: { all?: boolean }, callback: LookupCallback) {
        dnsLookup(hostname, { all: true }, (error, addresses) => {
          if (error) {
            callback(error, []);
            return;
          }
          const blocked = addresses.find((a) => !allowPrivate && !isPublicAddress(a.address));
          if (blocked || addresses.length === 0) {
            const refused: NodeJS.ErrnoException = new Error('The source address is not allowed.');
            refused.code = 'ESOURCEBLOCKED';
            callback(refused, []);
            return;
          }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]?.address ?? '', addresses[0]?.family);
        });
      },
    },
  });
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Literal addresses skip the lookup above, so they are checked here.
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
      return Promise.reject(new TypeError('fetch failed: the source address is not allowed'));
    }
    return undiciFetch(url, {
      ...(init as Record<string, unknown>),
      redirect: 'manual',
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  }) as typeof fetch;
}
