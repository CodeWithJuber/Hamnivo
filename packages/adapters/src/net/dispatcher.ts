import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, buildConnector, Pool } from 'undici';
import { addressBlock } from './address.js';
import {
  EgressError,
  type EgressPolicy,
  normalizeHost,
  type ResolvedAddress,
  systemResolver,
} from './policy.js';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

interface LookupOptions {
  all?: boolean;
  family?: number | string;
}

/** Response headers a server may send before the connection is given up on. */
const MAX_HEADER_BYTES = 16 * 1024;

function lookupFamily(options: LookupOptions): 0 | 4 | 6 {
  if (options.family === 4 || options.family === 'IPv4') return 4;
  if (options.family === 6 || options.family === 'IPv6') return 6;
  return 0;
}

/**
 * A `lookup` for node:net that resolves the host and refuses the connection when any address is
 * private. The check runs on the addresses the socket will actually use, so a host name that
 * resolved to a public address a moment ago and now points inside the network (DNS rebinding) is
 * still refused. `trusted` skips the refusal, for the administrator's trusted origins.
 */
export function guardedLookup(policy: EgressPolicy, trusted: boolean) {
  const resolve = policy.resolve ?? systemResolver;
  const failure = (error: unknown): NodeJS.ErrnoException =>
    (error instanceof EgressError
      ? error
      : new EgressError('unresolvable', 'The host name could not be resolved.', {
          cause: error,
        })) as NodeJS.ErrnoException;
  const choose = (addresses: ResolvedAddress[], options: LookupOptions): ResolvedAddress[] => {
    if (addresses.length === 0) {
      throw new EgressError('unresolvable', 'The host name could not be resolved.');
    }
    if (!trusted && addresses.some((entry) => addressBlock(entry.address) !== null)) {
      throw new EgressError('private_address', 'The host name resolves to a private network.');
    }
    const family = lookupFamily(options);
    const usable = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (usable.length === 0) {
      throw new EgressError('unresolvable', 'No address of the requested family.');
    }
    return usable;
  };
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    Promise.resolve()
      .then(() => resolve(hostname))
      .then(
        (addresses) => {
          let usable: ResolvedAddress[];
          try {
            usable = choose(addresses, options);
          } catch (error) {
            callback(failure(error), '', 0);
            return;
          }
          const [first] = usable;
          if (options.all || !first) callback(null, usable);
          else callback(null, first.address, first.family);
        },
        (error: unknown) => callback(failure(error), '', 0),
      )
      // The callback is Node's own and does not throw; this keeps a surprise from becoming an
      // unhandled rejection that would take the process down.
      .catch(() => undefined);
  };
}

/**
 * The connector of one origin's connections. A host name is resolved through the guarded lookup;
 * an IP literal never reaches a lookup, so it is judged here, by the same rules.
 */
function connectorFor(policy: EgressPolicy, trusted: boolean): buildConnector.connector {
  const connect = buildConnector({
    lookup: guardedLookup(policy, trusted) as never,
    allowH2: false,
  });
  return (options, callback) => {
    const host = normalizeHost(options.hostname);
    if (!trusted && isIP(host) && addressBlock(host) !== null) {
      callback(
        new EgressError('private_address', 'The address points to a private network.'),
        null,
      );
      return;
    }
    connect(options, callback);
  };
}

/**
 * The one connection guard (X05): an undici Agent that checks every address it connects to, at
 * the moment it connects. A host name is resolved by a `lookup` that refuses the connection when
 * any address it gets is private, so DNS rebinding cannot lead a request inside the network, and
 * an IP literal is judged the same way. Only origins in `policy.trustedOrigins` (exact scheme,
 * host and port) may be private. Redirects are never followed here: the callers go through
 * `guardedFetch` or `safeRequest`, which return a redirect as it is.
 *
 * Close or destroy it when the requests are done.
 */
export function guardedDispatcher(policy: EgressPolicy): Agent {
  const trustedOrigins = new Set(policy.trustedOrigins ?? []);
  return new Agent({
    factory: (origin, options) => {
      const trusted = trustedOrigins.has(new URL(String(origin)).origin);
      return new Pool(origin, {
        ...options,
        allowH2: false,
        maxHeaderSize: MAX_HEADER_BYTES,
        connect: connectorFor(policy, trusted),
      });
    },
  });
}
