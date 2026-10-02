export { type AddressBlock, addressBlock, isPublicAddress, mappedIpv4 } from './address.js';
export { guardedDispatcher, guardedLookup } from './dispatcher.js';
export { type GuardedFetch, type GuardedFetchOptions, guardedFetch } from './fetch.js';
export {
  checkDestination,
  checkUrl,
  type Destination,
  EgressError,
  type EgressPolicy,
  type EgressProblem,
  hostAllowed,
  normalizeHost,
  normalizeHostPattern,
  type ResolvedAddress,
  type Resolver,
  systemResolver,
} from './policy.js';
export { type EgressRequest, type EgressResponse, safeRequest } from './request.js';
