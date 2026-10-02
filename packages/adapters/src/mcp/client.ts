import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

export interface McpCallResult {
  /** The server says the tool ran and failed. */
  isError: boolean;
  structured: unknown;
  text: string | null;
}

export type McpFailureKind = 'egress' | 'timeout' | 'network' | 'refused' | 'protocol';

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
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: endpoint.timeoutMs,
      });
      for (const tool of result.tools) {
        if (tools.length >= MAX_TOOLS) break;
        tools.push({
          name: String(tool.name),
          title: typeof tool.title === 'string' ? tool.title : null,
          description: typeof tool.description === 'string' ? tool.description : null,
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
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
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
    const text = content
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
      text: text || null,
    };
  } catch (error) {
    throw classify(error, sent);
  } finally {
    await disconnect(connected);
  }
}
