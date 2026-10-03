import {
  checkDestination,
  EgressError,
  type EgressPolicy,
  type GuardedFetch,
  guardedFetch,
  type Resolver,
} from '@hamnivo/adapters/net';

/**
 * Guards requests to a source system a staff member names by URL (the Chatwoot migration source,
 * M04): only https, no credentials in the URL, and never an address inside the network Hamnivo
 * runs in (loopback, private, link-local, metadata endpoints, carrier NAT, multicast). The check is
 * made when the URL is given and again for every connection, so a name that later resolves to an
 * internal address (DNS rebinding) is refused too. Redirects are never followed.
 *
 * These are the rules of the one egress guard (`@hamnivo/adapters/net`) that every request made on
 * a tenant's behalf goes through. The only exception is development: with `allowPrivate`
 * (MIGRATION_SOURCE_ALLOW_PRIVATE) the source's own origin is trusted, for a Chatwoot on this
 * machine.
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

/** The policy for reading one source: public HTTPS, and its own origin only when development says so. */
function sourcePolicy(baseUrl: string, allowPrivate: boolean, resolve?: Resolver): EgressPolicy {
  let trustedOrigins: string[] = [];
  if (allowPrivate) {
    try {
      trustedOrigins = [new URL(baseUrl).origin];
    } catch {
      // Not a URL: the check refuses it.
    }
  }
  return { trustedOrigins, ...(resolve ? { resolve } : {}) };
}

function sourceProblem(error: EgressError): SourceUrlError {
  switch (error.problem) {
    case 'insecure_url':
      return new SourceUrlError('insecure_url', 'The address must start with https://.');
    case 'private_address':
      return new SourceUrlError('private_address', 'The address points inside a private network.');
    case 'unresolvable':
      return new SourceUrlError('unresolved', 'The address could not be found.');
    default:
      return new SourceUrlError('invalid_url', error.message);
  }
}

/**
 * Checks a source URL a person typed in and returns its origin (path, query and fragment are
 * dropped). `allowPrivate` is for development and tests against a local Chatwoot.
 */
export async function checkSourceUrl(
  raw: string,
  allowPrivate: boolean,
  resolve?: Resolver,
): Promise<URL> {
  try {
    const destination = await checkDestination(raw, sourcePolicy(raw, allowPrivate, resolve));
    return new URL(destination.url.origin);
  } catch (error) {
    if (error instanceof EgressError) throw sourceProblem(error);
    throw error;
  }
}

/**
 * A fetch for one source system: every connection is checked, and redirects are not followed (a
 * redirect comes back as the response it is, for the importer to judge). Close it when the read is
 * done.
 */
export function sourceFetch(
  baseUrl: string,
  allowPrivate: boolean,
  resolve?: Resolver,
): GuardedFetch {
  return guardedFetch(sourcePolicy(baseUrl, allowPrivate, resolve));
}
