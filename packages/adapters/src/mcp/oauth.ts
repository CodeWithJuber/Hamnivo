import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
  selectClientAuthMethod,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { EgressError, type EgressPolicy, type GuardedFetch, guardedFetch } from '../net/index.js';

/**
 * Signing in to a remote MCP server with OAuth, as the MCP authorization spec describes it: the
 * server answers 401 and points at its protected resource metadata (RFC 9728), which names an
 * authorization server (RFC 8414 or OpenID discovery), where Hamnivo registers itself (RFC 7591)
 * or uses a client a person entered, and signs in with an authorization code and PKCE (S256),
 * naming the server as the resource (RFC 8707). Access tokens are renewed with the refresh token.
 *
 * The protocol steps are the official SDK's (`@modelcontextprotocol/sdk/client/auth`); this file
 * only holds the state between requests in the shapes Hamnivo stores, and puts every request
 * through the egress guard under the workspace's policy. Redirects are followed only within the
 * address's own origin, and each hop is checked again. The discovery documents come from the
 * server and are untrusted: the authorization server must name itself as discovery found it, and
 * nothing is sent anywhere but where those documents point, over HTTPS and to public addresses.
 */

export type McpOAuthFailure =
  /** The address is not allowed (private network, not HTTPS, not on the allowed hosts). */
  | 'egress'
  /** The server needs no sign-in, or the sign-in service cannot be used by Hamnivo. */
  | 'unsupported'
  /** The sign-in service cannot register Hamnivo: a person must enter a client ID. */
  | 'registration_unsupported'
  /** The saved sign-in no longer works: a person signs in again. */
  | 'reconnect_required'
  /** The answer did not check out (a wrong state, issuer or code). */
  | 'invalid'
  /** The sign-in service did not answer, or answered something unusable. */
  | 'unavailable';

/** A sign-in step that failed, in words that are safe to show (never a response body). */
export class McpOAuthError extends Error {
  override readonly name = 'McpOAuthError';
  constructor(
    readonly kind: McpOAuthFailure,
    message: string,
    /** The OAuth error code the sign-in service gave, when it gave one. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** Where the authorization server and the resource metadata were found (plain JSON). */
export type McpOAuthDiscovery = OAuthDiscoveryState;

/** A client registration as the SDK reads it: it holds a secret when the client has one. */
export type McpOAuthClient = OAuthClientInformationMixed;

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, if the server said; null when it did not. */
  expiresAt: Date | null;
  scope: string | null;
  /** The token response as the SDK keeps it, bound to the authorization server it came from. */
  raw: OAuthTokens;
}

interface Base {
  /** The MCP server's address: the protected resource. */
  serverUrl: string;
  /** Where the authorization server sends the person back: HTTPS, or a local address. */
  redirectUri: string;
  /** The workspace's egress policy: public HTTPS, and its allowed hosts. */
  policy: EgressPolicy;
  clientName?: string;
  /** One deadline for everything a step sends (15 s by default). */
  timeoutMs?: number;
  now?: () => Date;
}

const RESPONSE_LIMIT = 262_144;

const sameAddress = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The words for what an authorization server answered, by its error code. */
const OAUTH_WORDS: Record<string, string> = {
  invalid_grant: 'The sign-in expired or was already used.',
  invalid_client: 'The sign-in service did not accept this client.',
  unauthorized_client: 'The sign-in service does not let this client sign in.',
  access_denied: 'The sign-in was not allowed.',
  invalid_scope: 'The sign-in service did not accept the access that was asked for.',
  invalid_request: 'The sign-in service did not accept the request.',
  temporarily_unavailable: 'The sign-in service is busy. Try again in a moment.',
};

function translate(error: unknown, phase: 'start' | 'finish' | 'refresh'): McpOAuthError {
  if (error instanceof McpOAuthError) return error;
  if (error instanceof EgressError) {
    return new McpOAuthError('egress', error.message, error.problem);
  }
  if (error instanceof OAuthError) {
    const code = error.errorCode;
    if (
      phase === 'refresh' &&
      ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(code)
    ) {
      return new McpOAuthError(
        'reconnect_required',
        'The saved sign-in no longer works. Sign in again.',
        code,
      );
    }
    return new McpOAuthError(
      phase === 'finish' ? 'invalid' : 'unavailable',
      OAUTH_WORDS[code] ?? `The sign-in service refused the request (${code}).`,
      code,
    );
  }
  const message = error instanceof Error ? error.message : '';
  if (/does not support dynamic client registration/i.test(message)) {
    return new McpOAuthError(
      'registration_unsupported',
      'This service does not let Hamnivo register itself. Enter a client ID from the service.',
    );
  }
  if (/Incompatible auth server/i.test(message)) {
    return new McpOAuthError(
      'unsupported',
      'The sign-in service does not support what Hamnivo needs.',
    );
  }
  if (/does not match expected/i.test(message)) {
    return new McpOAuthError(
      'invalid',
      'The service’s sign-in information is for a different address than the one you entered.',
    );
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out|aborted/i.test(message)) {
    return new McpOAuthError('unavailable', 'The sign-in service did not answer in time.');
  }
  return new McpOAuthError('unavailable', 'The sign-in service could not be used.');
}

/** A guarded fetch for one sign-in step, with one deadline for all of the requests it sends. */
function session(base: Pick<Base, 'policy' | 'timeoutMs'>) {
  const guard: GuardedFetch = guardedFetch(base.policy, { maxResponseBytes: RESPONSE_LIMIT });
  const deadline = AbortSignal.timeout(base.timeoutMs ?? 15_000);
  return {
    fetchFn: (url: string | URL, init?: RequestInit) =>
      guard(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      }),
    close: () => guard.close().catch(() => undefined),
  };
}

/** Runs the SDK's orchestrator on a guarded fetch. */
async function drive(
  base: Base,
  provider: OAuthClientProvider,
  options: { authorizationCode?: string; scope?: string; resourceMetadataUrl?: string },
  phase: 'start' | 'finish',
) {
  const { fetchFn, close } = session(base);
  try {
    return await auth(provider, {
      serverUrl: base.serverUrl,
      ...(options.authorizationCode !== undefined
        ? { authorizationCode: options.authorizationCode }
        : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(options.resourceMetadataUrl) }
        : {}),
      fetchFn,
    });
  } catch (error) {
    throw translate(error, phase);
  } finally {
    await close();
  }
}

function metadataOf(base: Base, scope: string | undefined): OAuthClientMetadata {
  return {
    client_name: base.clientName ?? 'Hamnivo',
    redirect_uris: [base.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Hamnivo proves who it is with PKCE; a service that issues a secret anyway gets it stored.
    token_endpoint_auth_method: 'none',
    ...(scope ? { scope } : {}),
  } as OAuthClientMetadata;
}

export interface McpAuthChallenge {
  /** `true`: the server answered 401. `false`: it answered without a sign-in. `null`: unclear. */
  required: boolean | null;
  /** Where the server says its protected resource metadata is (from `WWW-Authenticate`). */
  resourceMetadataUrl: string | null;
  scope: string | null;
}

/**
 * Asks the server to start a session without a token, to learn whether it wants a sign-in and
 * where its metadata is. Nothing is changed on the server by a session that only initializes.
 */
export async function probeMcpAuth(
  input: Pick<Base, 'serverUrl' | 'policy' | 'timeoutMs'>,
): Promise<McpAuthChallenge> {
  const guard = guardedFetch(input.policy, { maxResponseBytes: RESPONSE_LIMIT });
  try {
    const response = await guard(input.serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hamnivo', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      const params = extractWWWAuthenticateParams(response);
      return {
        required: true,
        resourceMetadataUrl: params.resourceMetadataUrl?.href ?? null,
        scope: params.scope ?? null,
      };
    }
    return {
      required: response.ok ? false : null,
      resourceMetadataUrl: null,
      scope: null,
    };
  } catch (error) {
    throw translate(error, 'start');
  } finally {
    await guard.close().catch(() => undefined);
  }
}

export interface McpOAuthStart {
  /** Where to send the person's browser. */
  authorizationUrl: string;
  /** The PKCE verifier: a secret that stays on the server until the person comes back. */
  codeVerifier: string;
  /** The registration (or the client a person entered), with the issuer it is bound to. */
  client: McpOAuthClient;
  registration: 'dynamic' | 'manual';
  /** The authorization server's URL as discovery found it. */
  authorizationServer: string;
  /** The resource indicator sent with the sign-in (RFC 8707). */
  resource: string;
  scope: string | null;
  discovery: McpOAuthDiscovery;
}

/**
 * Begins a sign-in: discovers the authorization server, registers Hamnivo with it (unless a
 * client is given), and builds the address the person's browser goes to. `state` is the random
 * value the authorization server must send back.
 */
export async function startMcpOAuth(
  input: Base & {
    state: string;
    /** A client from the service, for those that do not register clients themselves. */
    client?: { clientId: string; clientSecret?: string | undefined };
    scope?: string | undefined;
    /** From the server's 401, when it said (`probeMcpAuth`). */
    resourceMetadataUrl?: string | undefined;
  },
): Promise<McpOAuthStart> {
  let redirect: URL | null = null;
  let verifier = '';
  let registered: McpOAuthClient | undefined;
  let discovery: McpOAuthDiscovery | undefined;
  const given: McpOAuthClient | undefined = input.client
    ? {
        client_id: input.client.clientId,
        ...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}),
      }
    : undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return input.redirectUri;
    },
    get clientMetadata() {
      return metadataOf(input, input.scope);
    },
    state: () => input.state,
    clientInformation: () => registered ?? given,
    saveClientInformation: (client) => {
      registered = client;
    },
    tokens: () => undefined,
    saveTokens: () => {
      throw new Error('Tokens are not expected before the person has signed in');
    },
    redirectToAuthorization: (url) => {
      redirect = url;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (state) => {
      discovery = state;
    },
  };
  const result = await drive(
    input,
    provider,
    {
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
    },
    'start',
  );
  const url = redirect as URL | null;
  const found = discovery as McpOAuthDiscovery | undefined;
  const client = (registered ?? given) as McpOAuthClient | undefined;
  if (result !== 'REDIRECT' || !url || !found || !client || !verifier) {
    throw new McpOAuthError('unavailable', 'The sign-in could not be started.');
  }
  // The authorization server names itself in its metadata; it must be the one discovery went to.
  const issuer = found.authorizationServerMetadata?.issuer;
  if (issuer && !sameAddress(issuer, found.authorizationServerUrl)) {
    throw new McpOAuthError(
      'invalid',
      'The sign-in service names itself differently from where it was found.',
    );
  }
  // The browser is sent to the address in the server's own document: only web addresses.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new McpOAuthError('invalid', 'The sign-in service gave an address that cannot be used.');
  }
  return {
    authorizationUrl: url.href,
    codeVerifier: verifier,
    client,
    registration: given ? 'manual' : 'dynamic',
    authorizationServer: found.authorizationServerUrl,
    resource: url.searchParams.get('resource') ?? input.serverUrl,
    scope: url.searchParams.get('scope'),
    discovery: found,
  };
}

function tokensFrom(raw: OAuthTokens, now: Date): McpOAuthTokens {
  if (typeof raw.token_type === 'string' && raw.token_type.toLowerCase() !== 'bearer') {
    throw new McpOAuthError('unsupported', 'The sign-in service gave a token Hamnivo cannot send.');
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt:
      typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)
        ? new Date(now.getTime() + raw.expires_in * 1000)
        : null,
    scope: raw.scope ?? null,
    raw,
  };
}

/** Exchanges the code the person came back with for tokens (the PKCE verifier proves it is ours). */
export async function finishMcpOAuth(
  input: Base & {
    code: string;
    client: McpOAuthClient;
    codeVerifier: string;
    discovery: McpOAuthDiscovery;
  },
): Promise<McpOAuthTokens> {
  let saved: OAuthTokens | undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return input.redirectUri;
    },
    get clientMetadata() {
      return metadataOf(input, undefined);
    },
    clientInformation: () => input.client,
    tokens: () => undefined,
    saveTokens: (tokens) => {
      saved = tokens;
    },
    redirectToAuthorization: () => {
      throw new McpOAuthError('invalid', 'The sign-in could not be completed.');
    },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => input.codeVerifier,
    discoveryState: () => input.discovery,
  };
  const result = await drive(input, provider, { authorizationCode: input.code }, 'finish');
  const tokens = saved as OAuthTokens | undefined;
  if (result !== 'AUTHORIZED' || !tokens?.access_token) {
    throw new McpOAuthError('invalid', 'The sign-in service did not give an access token.');
  }
  return tokensFrom(tokens, (input.now ?? (() => new Date()))());
}

/**
 * Renews the access token with the refresh token. A refresh token the service no longer accepts
 * (or a client it forgot) is `reconnect_required`; a service that cannot be reached right now is
 * `unavailable`, and the saved sign-in is left as it is. This calls the refresh step itself, not
 * the SDK's orchestrator: that one starts a new sign-in when a refresh fails for any reason, which
 * would turn a service having a bad moment into a sign-in that needs a person.
 */
export async function refreshMcpOAuth(
  input: Pick<Base, 'policy' | 'timeoutMs' | 'now'> & {
    client: McpOAuthClient;
    /** What was saved from the sign-in: only the refresh token is used. */
    tokens: { refresh_token?: string | undefined };
    discovery: McpOAuthDiscovery;
    /** The resource indicator the sign-in was made for. */
    resource: string;
  },
): Promise<McpOAuthTokens> {
  const refreshToken = input.tokens.refresh_token;
  if (!refreshToken) {
    throw new McpOAuthError(
      'reconnect_required',
      'The sign-in has no way to be renewed. Sign in again.',
    );
  }
  const { fetchFn, close } = session(input);
  try {
    const metadata = input.discovery.authorizationServerMetadata;
    const renewed = await refreshAuthorization(input.discovery.authorizationServerUrl, {
      ...(metadata ? { metadata } : {}),
      clientInformation: input.client,
      refreshToken,
      resource: input.resource,
      fetchFn,
    });
    if (!renewed.access_token) {
      throw new McpOAuthError('unavailable', 'The sign-in service did not give an access token.');
    }
    return tokensFrom(
      { ...renewed, issuer: input.discovery.authorizationServerUrl },
      (input.now ?? (() => new Date()))(),
    );
  } catch (error) {
    throw translate(error, 'refresh');
  } finally {
    await close();
  }
}

/**
 * Tells the authorization server to forget a token (RFC 7009), when it has an endpoint for that.
 * Best effort: the token is dropped from Hamnivo either way, so a failure only means the service
 * keeps it until it expires.
 */
export async function revokeMcpOAuthToken(
  input: Pick<Base, 'policy' | 'timeoutMs'> & {
    token: string;
    kind: 'access_token' | 'refresh_token';
    client: McpOAuthClient;
    discovery: McpOAuthDiscovery;
  },
): Promise<boolean> {
  const metadata = input.discovery.authorizationServerMetadata;
  const endpoint = (metadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!endpoint) return false;
  const guard = guardedFetch(input.policy, { maxResponseBytes: 65_536 });
  try {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    const params = new URLSearchParams({ token: input.token, token_type_hint: input.kind });
    const supported = (metadata as { token_endpoint_auth_methods_supported?: string[] })
      ?.token_endpoint_auth_methods_supported;
    const method = selectClientAuthMethod(input.client, supported ?? []);
    if (method === 'client_secret_basic' && input.client.client_secret) {
      headers.set(
        'authorization',
        `Basic ${btoa(`${input.client.client_id}:${input.client.client_secret}`)}`,
      );
    } else {
      params.set('client_id', input.client.client_id);
      if (method === 'client_secret_post' && input.client.client_secret) {
        params.set('client_secret', input.client.client_secret);
      }
    }
    const response = await guard(endpoint, {
      method: 'POST',
      headers,
      body: params,
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    await guard.close().catch(() => undefined);
  }
}
