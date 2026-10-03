import { afterEach, describe, expect, it } from 'vitest';
import {
  finishMcpOAuth,
  listMcpTools,
  McpCallError,
  McpOAuthError,
  probeMcpAuth,
  refreshMcpOAuth,
  revokeMcpOAuthToken,
  startMcpOAuth,
} from '../src/mcp/index.js';
import {
  type FakeMcpServer,
  type FakeOAuthOptions,
  startFakeMcpServer,
} from '../src/mcp/testing.js';

const REDIRECT = 'https://studio.example/tools/oauth';
const open: FakeMcpServer[] = [];

async function serve(oauth: FakeOAuthOptions = {}): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer([{ name: 'lookup', description: 'Looks up.' }], {
    oauth,
  });
  open.push(server);
  return server;
}

/** The fake is on loopback over plain HTTP: reachable only as a trusted origin. */
const policy = (server: FakeMcpServer) => ({ trustedOrigins: [new URL(server.url).origin] });
const base = (server: FakeMcpServer) => ({
  serverUrl: server.url,
  redirectUri: REDIRECT,
  policy: policy(server),
  timeoutMs: 5000,
});
const endpoint = (server: FakeMcpServer, token?: string) => ({
  url: server.url,
  ...(token ? { token } : {}),
  trustedOrigins: [new URL(server.url).origin],
  timeoutMs: 3000,
});

/** Signs in the way a person would: start, press Allow, come back with the code. */
async function signIn(server: FakeMcpServer, overrides: { scope?: string } = {}) {
  const start = await startMcpOAuth({
    ...base(server),
    state: 'state-1',
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
  const back = await approve(server, start.authorizationUrl);
  const tokens = await finishMcpOAuth({
    ...base(server),
    code: back.searchParams.get('code') ?? '',
    client: start.client,
    codeVerifier: start.codeVerifier,
    discovery: start.discovery,
  });
  return { start, back, tokens };
}

async function approve(server: FakeMcpServer, authorizationUrl: string): Promise<URL> {
  if (!server.oauth) throw new Error('This server has no authorization server');
  return server.oauth.approve(authorizationUrl);
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

describe('what the server asks for', () => {
  it('reads the sign-in challenge from a 401', async () => {
    const server = await serve();
    const challenge = await probeMcpAuth(base(server));
    expect(challenge).toEqual({
      required: true,
      resourceMetadataUrl: `${new URL(server.url).origin}/.well-known/oauth-protected-resource/mcp`,
      scope: 'read write',
    });
  });

  it('reports a server that needs no sign-in', async () => {
    const open_ = await startFakeMcpServer([{ name: 'lookup' }]);
    open.push(open_);
    expect((await probeMcpAuth(base(open_))).required).toBe(false);
  });

  it('keeps going when the 401 does not say where the metadata is', async () => {
    const server = await serve({ hideMetadataInChallenge: true });
    const challenge = await probeMcpAuth(base(server));
    expect(challenge).toMatchObject({ required: true, resourceMetadataUrl: null });
    // Discovery then looks for the metadata at its well-known address.
    const { tokens } = await signIn(server);
    expect(tokens.accessToken).toMatch(/^at_/);
  });
});

describe('signing in', () => {
  it('discovers, registers, signs in with PKCE for this resource, and the token works', async () => {
    const server = await serve();
    const challenge = await probeMcpAuth(base(server));
    const start = await startMcpOAuth({
      ...base(server),
      state: 'state-abc',
      ...(challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
      ...(challenge.scope ? { scope: challenge.scope } : {}),
    });

    // The sign-in went to the authorization server the metadata named.
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${server.oauth?.issuer}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('resource')).toBe(server.url);
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(start).toMatchObject({
      registration: 'dynamic',
      authorizationServer: server.oauth?.issuer,
      resource: server.url,
      scope: 'read write',
    });
    // Hamnivo registered itself, as a client that proves itself with PKCE.
    expect(server.oauth?.registrations).toHaveLength(1);
    expect(server.oauth?.registrations[0]).toMatchObject({
      redirectUris: [REDIRECT],
      authMethod: 'none',
    });
    // The verifier is a secret held back: it is not in the address.
    expect(start.authorizationUrl).not.toContain(start.codeVerifier);

    const back = await approve(server, start.authorizationUrl);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-abc');
    const tokens = await finishMcpOAuth({
      ...base(server),
      code: back.searchParams.get('code') ?? '',
      client: start.client,
      codeVerifier: start.codeVerifier,
      discovery: start.discovery,
    });
    expect(tokens.refreshToken).toMatch(/^rt_/);
    expect(tokens.scope).toBe('read write');
    expect(tokens.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    // The resource indicator went to the token endpoint too.
    expect(server.oauth?.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'authorization_code',
      resource: server.url,
      redirect_uri: REDIRECT,
    });

    // Without the token the server answers 401, which Hamnivo tells apart from other refusals.
    const refused = await listMcpTools(endpoint(server)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(McpCallError);
    expect(refused).toMatchObject({ kind: 'auth', mayHaveApplied: false });
    const listed = await listMcpTools(endpoint(server, tokens.accessToken));
    expect(listed.tools.map((t) => t.name)).toEqual(['lookup']);
  });

  it('does not accept a code without the verifier it was asked with', async () => {
    const server = await serve();
    const start = await startMcpOAuth({ ...base(server), state: 's' });
    const back = await approve(server, start.authorizationUrl);
    const error = await finishMcpOAuth({
      ...base(server),
      code: back.searchParams.get('code') ?? '',
      client: start.client,
      codeVerifier: 'x'.repeat(64),
      discovery: start.discovery,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpOAuthError);
    expect(error).toMatchObject({ kind: 'invalid', code: 'invalid_grant' });
  });

  it('refuses an authorization server that names itself differently from where it was found', async () => {
    const server = await serve({ wrongIssuer: true });
    await expect(startMcpOAuth({ ...base(server), state: 's' })).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('asks for a client ID when the service cannot register one, and uses it with its secret', async () => {
    const server = await serve({
      registration: false,
      clients: 'confidential',
      preRegistered: { clientId: 'given-client', clientSecret: 'given-secret' },
    });
    await expect(startMcpOAuth({ ...base(server), state: 's' })).rejects.toMatchObject({
      kind: 'registration_unsupported',
    });
    const start = await startMcpOAuth({
      ...base(server),
      state: 's',
      client: { clientId: 'given-client', clientSecret: 'given-secret' },
    });
    expect(start.registration).toBe('manual');
    expect(server.oauth?.registrations).toHaveLength(0);
    const back = await approve(server, start.authorizationUrl);
    const tokens = await finishMcpOAuth({
      ...base(server),
      code: back.searchParams.get('code') ?? '',
      client: start.client,
      codeVerifier: start.codeVerifier,
      discovery: start.discovery,
    });
    expect(tokens.accessToken).toMatch(/^at_/);
  });

  it('stores a client secret the service issues, and uses it to sign in', async () => {
    const server = await serve({ clients: 'confidential' });
    const { start, tokens } = await signIn(server);
    expect(start.client.client_secret).toMatch(/^secret_/);
    expect(tokens.accessToken).toMatch(/^at_/);
  });

  it('is refused on a private address unless the administrator trusts it', async () => {
    const server = await serve();
    const error = await startMcpOAuth({
      serverUrl: server.url,
      redirectUri: REDIRECT,
      policy: {},
      state: 's',
      timeoutMs: 3000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpOAuthError);
    expect(error).toMatchObject({ kind: 'egress' });
    // The server saw nothing.
    expect(server.authorizations).toHaveLength(0);
  });
});

describe('keeping the sign-in alive', () => {
  it('renews the access token with the refresh token, and the refresh token turns over', async () => {
    const server = await serve();
    const { start, tokens } = await signIn(server);
    server.oauth?.expireAll();
    expect(
      await listMcpTools(endpoint(server, tokens.accessToken)).catch((e: unknown) => e),
    ).toMatchObject({
      kind: 'auth',
    });

    const renewed = await refreshMcpOAuth({
      ...base(server),
      client: start.client,
      tokens: tokens.raw,
      discovery: start.discovery,
      resource: start.resource,
    });
    expect(renewed.accessToken).not.toBe(tokens.accessToken);
    expect(renewed.refreshToken).not.toBe(tokens.refreshToken);
    expect(server.oauth?.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      resource: server.url,
    });
    expect((await listMcpTools(endpoint(server, renewed.accessToken))).tools).toHaveLength(1);

    // The first refresh token was used up: asking again with it needs a new sign-in.
    const stale = await refreshMcpOAuth({
      ...base(server),
      client: start.client,
      tokens: tokens.raw,
      discovery: start.discovery,
      resource: start.resource,
    }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(McpOAuthError);
    expect(stale).toMatchObject({ kind: 'reconnect_required', code: 'invalid_grant' });
  });

  it('keeps the old refresh token when the service does not replace it', async () => {
    const server = await serve();
    if (server.oauth) server.oauth.rotateRefresh = false;
    const { start, tokens } = await signIn(server);
    const renewed = await refreshMcpOAuth({
      ...base(server),
      client: start.client,
      tokens: tokens.raw,
      discovery: start.discovery,
      resource: start.resource,
    });
    expect(renewed.refreshToken).toBe(tokens.refreshToken);
  });

  it('asks for a new sign-in when the service refuses the refresh token', async () => {
    const server = await serve();
    const { start, tokens } = await signIn(server);
    if (server.oauth) server.oauth.failNextRefresh = 'invalid_grant';
    await expect(
      refreshMcpOAuth({
        ...base(server),
        client: start.client,
        tokens: tokens.raw,
        discovery: start.discovery,
        resource: start.resource,
      }),
    ).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('leaves the sign-in as it is when the service is only having trouble', async () => {
    const server = await serve();
    const { start, tokens } = await signIn(server);
    if (server.oauth) server.oauth.failNextRefresh = 'server_error';
    await expect(
      refreshMcpOAuth({
        ...base(server),
        client: start.client,
        tokens: tokens.raw,
        discovery: start.discovery,
        resource: start.resource,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    // The same refresh token still works once the service is back.
    const renewed = await refreshMcpOAuth({
      ...base(server),
      client: start.client,
      tokens: tokens.raw,
      discovery: start.discovery,
      resource: start.resource,
    });
    expect(renewed.accessToken).toMatch(/^at_/);
  });

  it('cannot renew a sign-in that has no refresh token', async () => {
    const server = await serve();
    const { start } = await signIn(server);
    await expect(
      refreshMcpOAuth({
        ...base(server),
        client: start.client,
        tokens: {},
        discovery: start.discovery,
        resource: start.resource,
      }),
    ).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('tells the service to forget a token when it has an endpoint for that', async () => {
    const server = await serve();
    const { start, tokens } = await signIn(server);
    const done = await revokeMcpOAuthToken({
      policy: policy(server),
      token: tokens.refreshToken ?? '',
      kind: 'refresh_token',
      client: start.client,
      discovery: start.discovery,
    });
    expect(done).toBe(true);
    expect(server.oauth?.revoked).toEqual([tokens.refreshToken]);
    // And a service that says nothing about revoking is left alone.
    const without = await revokeMcpOAuthToken({
      policy: policy(server),
      token: 'x',
      kind: 'access_token',
      client: start.client,
      discovery: { ...start.discovery, authorizationServerMetadata: undefined },
    });
    expect(without).toBe(false);
  });
});
