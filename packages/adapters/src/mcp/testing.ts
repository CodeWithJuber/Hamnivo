import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A stand-in MCP server for tests (Streamable HTTP, stateless, on 127.0.0.1). Tools are defined
 * with raw JSON Schemas and descriptions, so tests can serve hostile listings; each tool records
 * its calls, and faults can be injected before or after a tool applies its change. It can also
 * offer resources and prompts, and ask for an OAuth sign-in the way the MCP authorization spec
 * describes, with a stand-in authorization server on the same address (see `FakeOAuthOptions`).
 */

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string | null;
}

/**
 * `timeout_before`: never answers and changes nothing. `timeout_after`: applies the change, then
 * never answers (the answer is lost). `error`: answers `isError: true`.
 */
export type FakeMcpFault = 'timeout_before' | 'timeout_after' | 'error';

export interface FakeMcpTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  /** What the tool promises to return (the fake does not hold itself to it). */
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  /** Returns the tool result (text, structured content, or a raw MCP result). */
  handler?: (args: Record<string, unknown>, call: FakeToolCall) => unknown;
}

export interface FakeMcpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** The text a read returns. */
  text?: string;
  /** Base64 contents, for a binary resource. */
  blob?: string;
}

export interface FakeMcpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface FakeOAuthOptions {
  /** Whether `/register` exists (RFC 7591). Default true. */
  registration?: boolean;
  /** `confidential` clients are issued a secret and must use it. Default `public`. */
  clients?: 'public' | 'confidential';
  /** A client that exists without registering, for services that need one entered. */
  preRegistered?: { clientId: string; clientSecret?: string; redirectUris?: string[] };
  /** How long an access token lives. Default 3600. */
  accessTokenSeconds?: number;
  /** Scopes the server lists. Default `read write`. */
  scopes?: string[];
  /** A token the server accepts without any sign-in (a pasted token). */
  staticToken?: string;
  /** Leave `resource_metadata` out of the 401, so clients must find it by the well-known path. */
  hideMetadataInChallenge?: boolean;
  /** The authorization server names itself wrongly in its metadata. */
  wrongIssuer?: boolean;
  /** Add `iss` to the authorization response (RFC 9207) and say so in the metadata. */
  issuerInResponse?: boolean;
}

interface IssuedToken {
  clientId: string;
  expiresAt: number;
  scope: string;
}

export interface FakeOAuthServer {
  /** The address the authorization server names itself by. */
  issuer: string;
  /** The resource indicator the server expects (its MCP address). */
  resource: string;
  /** Clients that registered, in order. */
  registrations: { clientId: string; redirectUris: string[]; authMethod: string | undefined }[];
  /** Every form sent to `/token`, as the server read it (test assertions only). */
  tokenRequests: Record<string, string>[];
  /** Every form sent to `/authorize` as query parameters. */
  authorizationRequests: Record<string, string>[];
  revoked: string[];
  /** Answer the next refresh like this. */
  failNextRefresh: 'invalid_grant' | 'server_error' | null;
  /** A refresh replaces the refresh token (default true). */
  rotateRefresh: boolean;
  accessTokenSeconds: number;
  /** The access tokens the server accepts right now. */
  accessTokens: Map<string, IssuedToken>;
  /** A person presses "Allow": returns the address the browser comes back to. */
  approve(authorizationUrl: string): Promise<URL>;
  /** The access token stops working (revoked elsewhere). */
  expire(accessToken: string): void;
  /** Every access token stops working. */
  expireAll(): void;
}

export interface FakeMcpOptions {
  resources?: FakeMcpResource[];
  prompts?: FakeMcpPrompt[];
  oauth?: FakeOAuthOptions;
}

export interface FakeMcpServer {
  url: string;
  /** Every call that reached a tool's handler, in order. */
  calls: FakeToolCall[];
  /** Requests received, with their Authorization header. */
  authorizations: (string | null)[];
  tools: Map<string, FakeMcpTool>;
  resources: Map<string, FakeMcpResource>;
  prompts: Map<string, FakeMcpPrompt>;
  /** The URIs that were read, in order. */
  reads: string[];
  /** Listing resources fails with a server error. */
  failResourceListing: boolean;
  /** Faults for the next calls of a tool, used in order. */
  faults: Map<string, FakeMcpFault[]>;
  /**
   * The MCP revision the server answers `initialize` with, as an older (or unknown) server would;
   * null answers like the SDK, with the revision the client asked for.
   */
  protocolVersion: string | null;
  /** The stand-in authorization server, when the server asks for a sign-in. */
  oauth: FakeOAuthServer | null;
  setTools(tools: FakeMcpTool[]): void;
  close(): Promise<void>;
}

const hang = () => new Promise<never>(() => undefined);

function toResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && 'content' in (value as Record<string, unknown>)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

const random = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown, headers: object = {}) {
  res
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    })
    .end(JSON.stringify(body));
}

/** The stand-in authorization server: metadata, registration, PKCE, tokens and revocation. */
function oauthServer(
  options: FakeOAuthOptions,
  origin: () => string,
): {
  state: FakeOAuthServer;
  handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean>;
} {
  const scopes = options.scopes ?? ['read', 'write'];
  type Client = { redirectUris: string[]; secret: string | undefined; method: string };
  const clients = new Map<string, Client>();
  if (options.preRegistered) {
    clients.set(options.preRegistered.clientId, {
      redirectUris: options.preRegistered.redirectUris ?? [],
      secret: options.preRegistered.clientSecret,
      method: options.preRegistered.clientSecret ? 'client_secret_basic' : 'none',
    });
  }
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      resource: string | null;
      scope: string;
    }
  >();
  const refreshTokens = new Map<string, { clientId: string; scope: string }>();
  const state: FakeOAuthServer = {
    issuer: '',
    resource: '',
    registrations: [],
    tokenRequests: [],
    authorizationRequests: [],
    revoked: [],
    failNextRefresh: null,
    rotateRefresh: true,
    accessTokenSeconds: options.accessTokenSeconds ?? 3600,
    accessTokens: new Map(),
    async approve(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== 302 || !location) {
        throw new Error(`The authorization request was refused: ${response.status}`);
      }
      return new URL(location);
    },
    expire(accessToken) {
      state.accessTokens.delete(accessToken);
    },
    expireAll() {
      state.accessTokens.clear();
    },
  };

  const issue = (clientId: string, scope: string, withRefresh: boolean) => {
    const access = random('at');
    state.accessTokens.set(access, {
      clientId,
      scope,
      expiresAt: Date.now() + state.accessTokenSeconds * 1000,
    });
    const refresh = withRefresh ? random('rt') : null;
    if (refresh) refreshTokens.set(refresh, { clientId, scope });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: state.accessTokenSeconds,
      ...(refresh ? { refresh_token: refresh } : {}),
      scope,
    };
  };

  /** Who is asking at `/token`: the client and whether its credentials hold. */
  const authenticate = (req: IncomingMessage, form: URLSearchParams) => {
    let clientId = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    if (basic?.[1]) {
      const [id, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = id ?? null;
      secret = rest.join(':');
    }
    const client = clientId ? clients.get(clientId) : undefined;
    if (!clientId || !client) return null;
    if (client.secret !== undefined && client.secret !== secret) return null;
    return { clientId, client };
  };

  return {
    state,
    async handle(req, res, path, url) {
      state.issuer = origin();
      state.resource = `${origin()}/mcp`;
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, 200, {
          resource: state.resource,
          authorization_servers: [state.issuer],
          scopes_supported: scopes,
          bearer_methods_supported: ['header'],
        });
        return true;
      }
      if (path === '/.well-known/oauth-authorization-server') {
        json(res, 200, {
          issuer: options.wrongIssuer ? 'https://elsewhere.example' : state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          ...(options.registration === false
            ? {}
            : { registration_endpoint: `${state.issuer}/register` }),
          revocation_endpoint: `${state.issuer}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [
            'none',
            'client_secret_basic',
            'client_secret_post',
          ],
          scopes_supported: scopes,
          ...(options.issuerInResponse
            ? { authorization_response_iss_parameter_supported: true }
            : {}),
        });
        return true;
      }
      if (path === '/register' && req.method === 'POST') {
        if (options.registration === false) {
          json(res, 404, { error: 'not_found' });
          return true;
        }
        const body = JSON.parse((await readBody(req)) || '{}') as {
          redirect_uris?: string[];
          token_endpoint_auth_method?: string;
          client_name?: string;
        };
        const confidential = options.clients === 'confidential';
        const clientId = random('client');
        const secret = confidential ? random('secret') : undefined;
        const method = confidential
          ? 'client_secret_basic'
          : (body.token_endpoint_auth_method ?? 'none');
        clients.set(clientId, { redirectUris: body.redirect_uris ?? [], secret, method });
        state.registrations.push({
          clientId,
          redirectUris: body.redirect_uris ?? [],
          authMethod: body.token_endpoint_auth_method,
        });
        json(res, 201, {
          client_id: clientId,
          ...(secret ? { client_secret: secret } : {}),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: method,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: body.client_name,
        });
        return true;
      }
      if (path === '/authorize' && req.method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        state.authorizationRequests.push(query);
        const client = clients.get(query.client_id ?? '');
        const redirectUri = query.redirect_uri ?? '';
        const valid =
          client &&
          query.response_type === 'code' &&
          query.code_challenge &&
          query.code_challenge_method === 'S256' &&
          (client.redirectUris.length === 0 || client.redirectUris.includes(redirectUri));
        if (!valid) {
          json(res, 400, { error: 'invalid_request' });
          return true;
        }
        const code = random('code');
        codes.set(code, {
          clientId: query.client_id as string,
          redirectUri,
          challenge: query.code_challenge as string,
          resource: query.resource ?? null,
          scope: query.scope ?? scopes.join(' '),
        });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        if (query.state) back.searchParams.set('state', query.state);
        if (options.issuerInResponse) back.searchParams.set('iss', state.issuer);
        res.writeHead(302, { location: back.href }).end();
        return true;
      }
      if (path === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        state.tokenRequests.push(Object.fromEntries(form));
        const who = authenticate(req, form);
        if (!who) {
          json(res, 401, { error: 'invalid_client' });
          return true;
        }
        if (form.get('grant_type') === 'authorization_code') {
          const found = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const resource = form.get('resource');
          if (
            !found ||
            found.clientId !== who.clientId ||
            found.redirectUri !== form.get('redirect_uri') ||
            found.challenge !== challenge ||
            (resource !== null && resource !== state.resource)
          ) {
            json(res, 400, { error: 'invalid_grant' });
            return true;
          }
          json(res, 200, issue(who.clientId, found.scope, true));
          return true;
        }
        if (form.get('grant_type') === 'refresh_token') {
          const refresh = form.get('refresh_token') ?? '';
          const found = refreshTokens.get(refresh);
          if (state.failNextRefresh === 'server_error') {
            state.failNextRefresh = null;
            json(res, 500, { error: 'server_error' });
            return true;
          }
          if (
            state.failNextRefresh === 'invalid_grant' ||
            !found ||
            found.clientId !== who.clientId
          ) {
            state.failNextRefresh = null;
            json(res, 400, { error: 'invalid_grant' });
            return true;
          }
          const resource = form.get('resource');
          if (resource !== null && resource !== state.resource) {
            json(res, 400, { error: 'invalid_target' });
            return true;
          }
          if (state.rotateRefresh) refreshTokens.delete(refresh);
          const tokens = issue(who.clientId, found.scope, state.rotateRefresh);
          json(res, 200, tokens);
          return true;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return true;
      }
      if (path === '/revoke' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const token = form.get('token') ?? '';
        state.revoked.push(token);
        state.accessTokens.delete(token);
        refreshTokens.delete(token);
        res.writeHead(200).end();
        return true;
      }
      return false;
    },
  };
}

export async function startFakeMcpServer(
  initial: FakeMcpTool[] = [],
  options: FakeMcpOptions = {},
): Promise<FakeMcpServer> {
  const tools = new Map<string, FakeMcpTool>(initial.map((t) => [t.name, t]));
  const resources = new Map<string, FakeMcpResource>(
    (options.resources ?? []).map((r) => [r.uri, r]),
  );
  const prompts = new Map<string, FakeMcpPrompt>((options.prompts ?? []).map((p) => [p.name, p]));
  const faults = new Map<string, FakeMcpFault[]>();
  const calls: FakeToolCall[] = [];
  const authorizations: (string | null)[] = [];
  const origin = () => new URL(fake.url).origin;
  const oauth = options.oauth ? oauthServer(options.oauth, origin) : null;
  const fake: FakeMcpServer = {
    url: '',
    calls,
    authorizations,
    tools,
    resources,
    prompts,
    reads: [],
    failResourceListing: false,
    faults,
    protocolVersion: null,
    oauth: oauth?.state ?? null,
    setTools(next) {
      tools.clear();
      for (const tool of next) tools.set(tool.name, tool);
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };

  const offersResources = options.resources !== undefined;
  const offersPrompts = options.prompts !== undefined;

  const mcp = () => {
    const server = new Server(
      { name: 'Fake orders service', version: '1.0.0' },
      {
        capabilities: {
          tools: {},
          ...(offersResources ? { resources: {} } : {}),
          ...(offersPrompts ? { prompts: {} } : {}),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    }));
    if (offersResources) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        if (fake.failResourceListing) {
          throw new McpError(ErrorCode.InternalError, 'The resource list is not available');
        }
        return {
          resources: [...resources.values()].map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          })),
        };
      });
      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const resource = resources.get(request.params.uri);
        if (!resource) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${request.params.uri}`);
        }
        fake.reads.push(resource.uri);
        return {
          contents: [
            {
              uri: resource.uri,
              ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
              ...(resource.blob !== undefined
                ? { blob: resource.blob }
                : { text: resource.text ?? '' }),
            },
          ],
        };
      });
    }
    if (offersPrompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: [...prompts.values()].map((prompt) => ({
          name: prompt.name,
          ...(prompt.title ? { title: prompt.title } : {}),
          ...(prompt.description ? { description: prompt.description } : {}),
          ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
        })),
      }));
    }
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const tool = tools.get(name);
      if (!tool) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
      }
      const meta = request.params._meta as Record<string, unknown> | undefined;
      const call: FakeToolCall = {
        name,
        arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
        idempotencyKey:
          typeof meta?.['hamnivo/idempotency-key'] === 'string'
            ? (meta['hamnivo/idempotency-key'] as string)
            : null,
      };
      const fault = faults.get(name)?.shift();
      if (fault === 'timeout_before') return hang();
      calls.push(call);
      const value = tool.handler ? tool.handler(call.arguments, call) : { ok: true };
      if (fault === 'timeout_after') return hang();
      if (fault === 'error') {
        return { isError: true, content: [{ type: 'text', text: 'The service failed.' }] };
      }
      return toResult(value) as never;
    });
    return server;
  };

  /** With a sign-in: the token on the request must be one the authorization server issued. */
  const signedIn = (req: IncomingMessage): boolean => {
    if (!oauth) return true;
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    const token = match?.[1];
    if (!token) return false;
    if (token === options.oauth?.staticToken) return true;
    const issued = oauth.state.accessTokens.get(token);
    return Boolean(issued && issued.expiresAt > Date.now());
  };

  const http: HttpServer = createServer(async (req, res) => {
    authorizations.push((req.headers.authorization as string | undefined) ?? null);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (oauth && (await oauth.handle(req, res, url.pathname, url))) return;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    if (!signedIn(req)) {
      const challenge = options.oauth?.hideMetadataInChallenge
        ? 'Bearer realm="mcp"'
        : `Bearer realm="mcp", resource_metadata="${origin()}/.well-known/oauth-protected-resource/mcp", scope="${(options.oauth?.scopes ?? ['read', 'write']).join(' ')}"`;
      res
        .writeHead(401, { 'www-authenticate': challenge, 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const initialize = body as { method?: unknown; id?: unknown };
    if (fake.protocolVersion && initialize.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: initialize.id,
          result: {
            protocolVersion: fake.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'Fake orders service', version: '1.0.0' },
          },
        }),
      );
      return;
    }
    const server = mcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  fake.url = `http://127.0.0.1:${port}/mcp`;
  return fake;
}
