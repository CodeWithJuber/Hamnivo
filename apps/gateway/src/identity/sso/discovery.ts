import { checkDestination, EgressError, type EgressPolicy } from '@hamnivo/adapters/net';
import { fetchJson, OutboundResponseError } from '../../common/outbound.js';

export interface DiscoveredEndpoints {
  authorization: string;
  token: string;
  jwks: string;
  userInfo: string | null;
  tokenEndpointAuth: 'client_secret_basic' | 'client_secret_post';
}

export type DiscoveryProblemCode =
  | 'issuer_invalid'
  | 'issuer_unreachable'
  | 'issuer_mismatch'
  | 'incomplete'
  | 'endpoint_not_allowed'
  | 'unsupported_client_auth';

export class DiscoveryProblem extends Error {
  override name = 'DiscoveryProblem';
  constructor(
    readonly code: DiscoveryProblemCode,
    message: string,
  ) {
    super(message);
  }
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

/**
 * Reads an OpenID Connect provider's discovery document when a tenant saves a connection (A13),
 * checks it, and keeps the endpoints so sign-ins never need to discover again. The issuer must
 * name itself exactly, and every endpoint the server calls must pass the same outbound checks
 * (the egress guard: HTTPS, publicly routable, or an origin the server administrator trusts).
 */
export async function discoverOidc(
  issuer: string,
  policy: EgressPolicy,
): Promise<DiscoveredEndpoints> {
  try {
    await checkDestination(issuer, policy);
  } catch (error) {
    if (error instanceof EgressError) {
      throw new DiscoveryProblem(
        'issuer_invalid',
        error.problem === 'insecure_url'
          ? 'The issuer must use HTTPS.'
          : error.problem === 'private_address'
            ? 'The issuer is on a private network. A server administrator can allow it.'
            : 'The issuer address could not be used.',
      );
    }
    throw error;
  }
  let document: Record<string, unknown>;
  try {
    const raw = await fetchJson(`${trimSlash(issuer)}/.well-known/openid-configuration`, policy);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DiscoveryProblem('incomplete', 'The discovery document is not a JSON object.');
    }
    document = raw as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DiscoveryProblem) throw error;
    if (error instanceof OutboundResponseError || error instanceof EgressError) {
      throw new DiscoveryProblem(
        'issuer_unreachable',
        'The identity provider’s discovery document could not be read. Check the issuer URL.',
      );
    }
    throw error;
  }
  if (typeof document.issuer !== 'string' || trimSlash(document.issuer) !== trimSlash(issuer)) {
    throw new DiscoveryProblem(
      'issuer_mismatch',
      'The provider names a different issuer than the one entered.',
    );
  }
  const endpoint = (key: string) => {
    const value = document[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const authorization = endpoint('authorization_endpoint');
  const token = endpoint('token_endpoint');
  const jwks = endpoint('jwks_uri');
  const userInfo = endpoint('userinfo_endpoint');
  if (!authorization || !token || !jwks) {
    throw new DiscoveryProblem(
      'incomplete',
      'The discovery document lacks an authorization, token or key endpoint.',
    );
  }
  for (const url of [authorization, token, jwks, ...(userInfo ? [userInfo] : [])]) {
    try {
      await checkDestination(url, policy);
    } catch (error) {
      if (error instanceof EgressError) {
        throw new DiscoveryProblem(
          'endpoint_not_allowed',
          'An endpoint of the provider is not on HTTPS or is on a private network.',
        );
      }
      throw error;
    }
  }
  const methods = Array.isArray(document.token_endpoint_auth_methods_supported)
    ? (document.token_endpoint_auth_methods_supported as unknown[])
    : ['client_secret_basic'];
  const tokenEndpointAuth = methods.includes('client_secret_basic')
    ? 'client_secret_basic'
    : methods.includes('client_secret_post')
      ? 'client_secret_post'
      : null;
  if (!tokenEndpointAuth) {
    throw new DiscoveryProblem(
      'unsupported_client_auth',
      'The provider accepts neither client_secret_basic nor client_secret_post.',
    );
  }
  return { authorization, token, jwks, userInfo, tokenEndpointAuth };
}
