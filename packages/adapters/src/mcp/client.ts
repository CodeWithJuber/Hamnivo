import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EgressError, type EgressPolicy, guardedFetch } from '../egress/fetch.js';

/**
 * MCP adapter (D10): remote MCP servers over Streamable HTTP only (no local processes, no SSE
 * fallback), every request through the egress guard, a bearer token when the tenant stored one.
 * What a server says about its tools (names, descriptions, schemas) is untrusted data: callers
 * reduce schemas to the portable subset and never show descriptions to a model as instructions.
 * MCP is an adapter for tools, not a source of authority: Hamnivo decides who may call what.
 */

/** Protocol revisions this adapter is tested against (also documented in the README). */
export const MCP_SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'] as const;

export interface McpEndpoint {
  url: string;
  /** Sent as `Authorization: Bearer …`; revealed just in time by the caller, never logged. */
  token?: string | null;
  /** Hosts the call may reach; the server's own host is added automatically. */
  allowedHosts?: readonly string[];
  /** Development and tests only: plain HTTP and loopback servers. */
  allowPrivate?: boolean;
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
    allowPrivate: endpoint.allowPrivate ?? false,
    maxResponseBytes: endpoint.maxResponseBytes ?? 1_048_576,
  };
}

async function connect(endpoint: McpEndpoint, signal: AbortSignal): Promise<Client> {
  const url = new URL(endpoint.url);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: guardedFetch(policyOf(endpoint)),
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
  return client;
}

/** Classifies a failure; `sent` is whether the tool call itself had been sent. */
function classify(error: unknown, sent: boolean): McpCallError {
  if (error instanceof McpCallError) return error;
  if (error instanceof EgressError) {
    // Refused before connecting, or a response cut at the size limit (the call ran).
    return new McpCallError('egress', error.message, error.reason === 'response_too_large' && sent);
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
  let client: Client | null = null;
  try {
    client = await connect(endpoint, signal);
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
      protocolVersion:
        (client as unknown as { _transport?: { protocolVersion?: string } })._transport
          ?.protocolVersion ?? null,
      serverName: version?.name ? String(version.name).slice(0, 120) : null,
      tools,
    };
  } catch (error) {
    throw classify(error, false);
  } finally {
    await client?.close().catch(() => undefined);
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
  let client: Client | null = null;
  let sent = false;
  try {
    client = await connect(endpoint, signal);
    sent = true;
    const result = await client.callTool(
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
    await client?.close().catch(() => undefined);
  }
}
