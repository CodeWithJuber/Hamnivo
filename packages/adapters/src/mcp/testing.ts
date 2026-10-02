import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * A stand-in MCP server for tests (Streamable HTTP, stateless, on 127.0.0.1). Tools are defined
 * with raw JSON Schemas and descriptions, so tests can serve hostile listings; each tool records
 * its calls, and faults can be injected before or after a tool applies its change.
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

export interface FakeMcpServer {
  url: string;
  /** Every call that reached a tool's handler, in order. */
  calls: FakeToolCall[];
  /** Requests received, with their Authorization header. */
  authorizations: (string | null)[];
  tools: Map<string, FakeMcpTool>;
  /** Faults for the next calls of a tool, used in order. */
  faults: Map<string, FakeMcpFault[]>;
  /**
   * The MCP revision the server answers `initialize` with, as an older (or unknown) server would;
   * null answers like the SDK, with the revision the client asked for.
   */
  protocolVersion: string | null;
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

export async function startFakeMcpServer(initial: FakeMcpTool[] = []): Promise<FakeMcpServer> {
  const tools = new Map<string, FakeMcpTool>(initial.map((t) => [t.name, t]));
  const faults = new Map<string, FakeMcpFault[]>();
  const calls: FakeToolCall[] = [];
  const authorizations: (string | null)[] = [];
  const fake: FakeMcpServer = {
    url: '',
    calls,
    authorizations,
    tools,
    faults,
    protocolVersion: null,
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

  const mcp = () => {
    const server = new Server(
      { name: 'Fake orders service', version: '1.0.0' },
      { capabilities: { tools: {} } },
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

  const http: HttpServer = createServer(async (req: IncomingMessage, res) => {
    authorizations.push((req.headers.authorization as string | undefined) ?? null);
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
