import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPublicAddress } from '../common/outbound.js';

// The same address rules as every other request made on a tenant's behalf.
export { isPublicAddress };

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
