import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  EgressError,
  type EgressPolicy,
  type GuardedFetch,
  guardedFetch,
  type Resolver,
} from '../net/index.js';

/**
 * MCP adapter (D10): remote MCP servers over Streamable HTTP only (no local processes, no SSE
 * fallback), every request through the egress guard (`../net`, the one guard for every request
 * made on a tenant's behalf), a bearer token when the tenant stored one.
 * What a server says about its tools (names, descriptions, schemas) is untrusted data: callers
 * reduce schemas to the portable subset and never show descriptions to a model as instructions.
 * MCP is an adapter for tools, not a source of authority: Hamnivo decides who may call what.
 * Besides tools it lists a server's resources and prompts (also untrusted text) and reads one
 * resource's text; signing in with OAuth is in `./oauth`, which ends in the same bearer token.
 */

/**
 * The MCP revisions Hamnivo accepts: the ones with Streamable HTTP. The SDK offers the newest; a
 * server may answer with an older one from this list, and anything else is refused. Each one is
 * tested in test/mcp.test.ts and documented in the README.
 */
export const MCP_SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const supported = (version: string | undefined): boolean =>
  (MCP_SUPPORTED_PROTOCOLS as readonly string[]).includes(version ?? '');

export interface McpEndpoint {
  url: string;
  /** Sent as `Authorization: Bearer …`; revealed just in time by the caller, never logged. */
  token?: string | null;
  /** Hosts the call may reach; the server's own host is added automatically. */
  allowedHosts?: readonly string[];
  /**
   * Origins that may be reached over plain HTTP and on private addresses (loopback test servers).
   * Development and tests only: never set from tenant input.
   */
  trustedOrigins?: readonly string[];
  /** Host name resolution; the system resolver by default (tests replace it). */
  resolve?: Resolver;
  timeoutMs: number;
  maxResponseBytes?: number;
}

export interface McpToolInfo {
  name: string;
  title: string | null;
  /** Untrusted text from the server. */
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  } | null;
}

export interface McpListing {
  protocolVersion: string | null;
  serverName: string | null;
  tools: McpToolInfo[];
}

/** A resource a server offers: all of it is untrusted text from the server. */
export interface McpResourceInfo {
  uri: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface McpPromptInfo {
  name: string;
  title: string | null;
  description: string | null;
  arguments: { name: string; description: string | null; required: boolean }[];
}

export interface McpCatalog extends McpListing {
  /** `null`: the server offers them but could not list them this time. */
  resources: McpResourceInfo[] | null;
  prompts: McpPromptInfo[] | null;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string | null;
  /** The text contents, joined; empty for a resource that is only binary. */
  text: string;
  truncated: boolean;
  /** Bytes of binary contents that were left out. */
  binaryBytes: number;
}

export interface McpCallResult {
  /** The server says the tool ran and failed. */
  isError: boolean;
  structured: unknown;
  text: string | null;
}

/**
 * `auth`: the server answered 401, so the token is missing, expired or revoked. Nothing was done,
 * and signing in again (or refreshing the token) is the way out.
 */
export type McpFailureKind = 'egress' | 'timeout' | 'network' | 'refused' | 'protocol' | 'auth';

/**
 * A failed MCP request. `mayHaveApplied` answers the question that matters after a write: a
 * refused request did nothing, but a timeout or a lost connection after sending may have, so the
 * action becomes "outcome unknown" and is never sent again blindly.
 */
export class McpCallError extends Error {
  override readonly name = 'McpCallError';
  constructor(
    readonly kind: McpFailureKind,
    message: string,
    readonly mayHaveApplied: boolean,
  ) {
    super(message);
  }
}

const MAX_TOOLS = 200;
const MAX_RESOURCES = 200;
const MAX_PROMPTS = 100;
const MAX_PAGES = 10;

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function policyOf(endpoint: McpEndpoint): EgressPolicy {
  return {
    allowedHosts: [hostOf(endpoint.url), ...(endpoint.allowedHosts ?? [])],
    trustedOrigins: endpoint.trustedOrigins ?? [],
    ...(endpoint.resolve ? { resolve: endpoint.resolve } : {}),
  };
}

interface Connection {
  client: Client;
  protocolVersion: string;
  /** The guarded fetch the connection runs on: close it with the client. */
  guard: GuardedFetch;
}

/** Connects and checks the revision the server chose; returns the client and that revision. */
async function connect(endpoint: McpEndpoint, signal: AbortSignal): Promise<Connection> {
  const url = new URL(endpoint.url);
  // Redirects are refused, and a response stops at the size limit.
  const guard = guardedFetch(policyOf(endpoint), {
    maxResponseBytes: endpoint.maxResponseBytes ?? 1_048_576,
    refuseRedirects: true,
  });
  try {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: guard,
      ...(endpoint.token
        ? { requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } } }
        : {}),
      reconnectionOptions: {
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    const client = new Client({ name: 'hamnivo', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, { signal, timeout: endpoint.timeoutMs });
    const protocolVersion = transport.protocolVersion;
    if (!protocolVersion || !supported(protocolVersion)) {
      await client.close().catch(() => undefined);
      throw new McpCallError(
        'protocol',
        `The server speaks MCP ${String(protocolVersion ?? 'without a version').slice(0, 40)}; Hamnivo supports ${MCP_SUPPORTED_PROTOCOLS.join(', ')}.`,
        false,
      );
    }
    return { client, protocolVersion, guard };
  } catch (error) {
    await guard.close().catch(() => undefined);
    throw error;
  }
}

/** Ends a connection: the client first, then the connections the guard opened for it. */
async function disconnect(connection: Connection | null): Promise<void> {
  await connection?.client.close().catch(() => undefined);
  await connection?.guard.close().catch(() => undefined);
}

/** Classifies a failure; `sent` is whether the tool call itself had been sent. */
function classify(error: unknown, sent: boolean): McpCallError {
  if (error instanceof McpCallError) return error;
  if (error instanceof EgressError) {
    // Refused before connecting, or a response cut at the size limit (the call ran).
    return new McpCallError(
      'egress',
      error.message,
      error.problem === 'response_too_large' && sent,
    );
  }
  // A 401 is answered before anything runs: the token is the problem, and nothing was done.
  if (error instanceof StreamableHTTPError && error.code === 401) {
    return new McpCallError('auth', 'The service did not accept the saved sign-in.', false);
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out|aborted/i.test(message)) {
    return new McpCallError('timeout', 'The tool did not answer in time.', sent);
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') {
    // JSON-RPC errors are the server's refusal: nothing was done.
    return new McpCallError('refused', `The server refused the request (${code}).`, false);
  }
  if (/HTTP 4\d\d|Error POSTing to endpoint \(HTTP 4/i.test(message)) {
    return new McpCallError('refused', 'The server refused the request.', false);
  }
  return new McpCallError('network', 'The tool could not be reached.', sent);
}

function withDeadline(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, deadline]) : deadline;
}

/** One page of a list a server offers, as the SDK returns it. */
interface Page<T> {
  items: T[];
  nextCursor: string | undefined;
}

/** Reads a cursor-paged list up to the bounds: pages, and items in all. */
async function collect<T>(
  max: number,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && items.length < max; page += 1) {
    const result = await fetchPage(cursor);
    for (const item of result.items) {
      if (items.length >= max) break;
      items.push(item);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function collectTools(
  client: Client,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<McpToolInfo[]> {
  return collect(MAX_TOOLS, async (cursor) => {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs });
    return {
      nextCursor: result.nextCursor,
      items: result.tools.map(
        (tool): McpToolInfo => ({
          name: String(tool.name),
          title: text(tool.title),
          description: text(tool.description),
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
          annotations: tool.annotations
            ? {
                ...(typeof tool.annotations.readOnlyHint === 'boolean'
                  ? { readOnlyHint: tool.annotations.readOnlyHint }
                  : {}),
                ...(typeof tool.annotations.destructiveHint === 'boolean'
                  ? { destructiveHint: tool.annotations.destructiveHint }
                  : {}),
                ...(typeof tool.annotations.idempotentHint === 'boolean'
                  ? { idempotentHint: tool.annotations.idempotentHint }
                  : {}),
              }
            : null,
        }),
      ),
    };
  });
}

function collectResources(
  client: Client,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<McpResourceInfo[]> {
  return collect(MAX_RESOURCES, async (cursor) => {
    const result = await client.listResources(cursor ? { cursor } : {}, {
      signal,
      timeout: timeoutMs,
    });
    return {
      nextCursor: result.nextCursor,
      items: result.resources.map(
        (resource): McpResourceInfo => ({
          uri: String(resource.uri),
          name: String(resource.name),
          title: text(resource.title),
          description: text(resource.description),
          mimeType: text(resource.mimeType),
          size: typeof resource.size === 'number' ? resource.size : null,
        }),
      ),
    };
  });
}

function collectPrompts(
  client: Client,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<McpPromptInfo[]> {
  return collect(MAX_PROMPTS, async (cursor) => {
    const result = await client.listPrompts(cursor ? { cursor } : {}, {
      signal,
      timeout: timeoutMs,
    });
    return {
      nextCursor: result.nextCursor,
      items: result.prompts.map(
        (prompt): McpPromptInfo => ({
          name: String(prompt.name),
          title: text(prompt.title),
          description: text(prompt.description),
          arguments: (prompt.arguments ?? []).slice(0, 20).map((argument) => ({
            name: String(argument.name),
            description: text(argument.description),
            required: argument.required === true,
          })),
        }),
      ),
    };
  });
}

/** Lists the server's tools (bounded), with what it says about itself. */
export async function listMcpTools(
  endpoint: McpEndpoint,
  outer?: AbortSignal,
): Promise<McpListing> {
  const signal = withDeadline(endpoint.timeoutMs, outer);
  let connected: Connection | null = null;
  try {
    connected = await connect(endpoint, signal);
    const { client } = connected;
    const tools = await collectTools(client, signal, endpoint.timeoutMs);
    const version = client.getServerVersion();
    return {
      protocolVersion: connected.protocolVersion,
      serverName: version?.name ? String(version.name).slice(0, 120) : null,
      tools,
    };
  } catch (error) {
    throw classify(error, false);
  } finally {
    await disconnect(connected);
  }
}

/**
 * Lists everything a server offers on one connection: tools, and the resources and prompts when
 * it has them. A list that the server could not give (it failed, or answered something unusable)
 * is `null`, not empty: a caller keeping a copy must not take "unknown" for "nothing".
 */
export async function listMcpCatalog(
  endpoint: McpEndpoint,
  outer?: AbortSignal,
): Promise<McpCatalog> {
  const signal = withDeadline(endpoint.timeoutMs, outer);
  let connected: Connection | null = null;
  try {
    connected = await connect(endpoint, signal);
    const { client } = connected;
    const capabilities = client.getServerCapabilities() ?? {};
    const tools = await collectTools(client, signal, endpoint.timeoutMs);
    const optional = async <T>(offered: boolean, read: () => Promise<T[]>): Promise<T[] | null> => {
      if (!offered) return [];
      try {
        return await read();
      } catch (error) {
        // A server that is out of reach, too slow or no longer accepting the sign-in fails the
        // whole listing; one that only cannot list this kind (or answers badly) loses this part.
        const failure = classify(error, false);
        if (failure.kind === 'egress' || failure.kind === 'timeout' || failure.kind === 'auth') {
          throw error;
        }
        return null;
      }
    };
    const resources = await optional(Boolean(capabilities.resources), () =>
      collectResources(client, signal, endpoint.timeoutMs),
    );
    const prompts = await optional(Boolean(capabilities.prompts), () =>
      collectPrompts(client, signal, endpoint.timeoutMs),
    );
    const version = client.getServerVersion();
    return {
      protocolVersion: connected.protocolVersion,
      serverName: version?.name ? String(version.name).slice(0, 120) : null,
      tools,
      resources,
      prompts,
    };
  } catch (error) {
    throw classify(error, false);
  } finally {
    await disconnect(connected);
  }
}

/**
 * Reads one resource as text. Binary contents are not passed on (only their size), and the text
 * is cut at `maxChars`. The URI is the caller's to vet: a server's resource URIs mean what that
 * server says, so only URIs a person has accepted should ever get here.
 */
export async function readMcpResource(
  endpoint: McpEndpoint,
  uri: string,
  options: { signal?: AbortSignal; maxChars?: number } = {},
): Promise<McpResourceContent> {
  const signal = withDeadline(endpoint.timeoutMs, options.signal);
  const maxChars = options.maxChars ?? 20_000;
  let connected: Connection | null = null;
  try {
    connected = await connect(endpoint, signal);
    const result = await connected.client.readResource(
      { uri },
      { signal, timeout: endpoint.timeoutMs },
    );
    const parts: string[] = [];
    let binaryBytes = 0;
    let mimeType: string | null = null;
    for (const content of result.contents) {
      mimeType ??= text(content.mimeType);
      if ('text' in content && typeof content.text === 'string') parts.push(content.text);
      else if ('blob' in content && typeof content.blob === 'string') {
        // Base64: three bytes for every four characters.
        binaryBytes += Math.floor((content.blob.length * 3) / 4);
      }
    }
    const joined = parts.join('\n\n');
    return {
      uri,
      mimeType,
      text: joined.length > maxChars ? joined.slice(0, maxChars) : joined,
      truncated: joined.length > maxChars,
      binaryBytes,
    };
  } catch (error) {
    throw classify(error, false);
  } finally {
    await disconnect(connected);
  }
}

/**
 * Calls one tool. The idempotency key goes in the request's `_meta`, for servers that honour it;
 * an outcome that may have applied is reported as such and must be reconciled, not resent.
 */
export async function callMcpTool(
  endpoint: McpEndpoint,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; idempotencyKey: string },
): Promise<McpCallResult> {
  const signal = withDeadline(endpoint.timeoutMs, options.signal);
  let connected: Connection | null = null;
  let sent = false;
  try {
    connected = await connect(endpoint, signal);
    sent = true;
    const result = await connected.client.callTool(
      {
        name,
        arguments: args,
        _meta: { 'hamnivo/idempotency-key': options.idempotencyKey },
      },
      undefined,
      { signal, timeout: endpoint.timeoutMs },
    );
    const content = Array.isArray(result.content) ? result.content : [];
    const joined = content
      .map((part) =>
        part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
    return {
      isError: result.isError === true,
      structured: result.structuredContent ?? null,
      text: joined || null,
    };
  } catch (error) {
    throw classify(error, sent);
  } finally {
    await disconnect(connected);
  }
}
