export { type AddressBlock, addressBlock, isPublicAddress, mappedIpv4 } from './address.js';
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
export {
  type EgressRequest,
  type EgressResponse,
  guardedLookup,
  safeRequest,
} from './request.js';
