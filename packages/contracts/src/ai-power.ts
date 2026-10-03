import { z } from 'zod';
import { RunStep } from './agents.js';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import { KnowledgeVisibility } from './knowledge.js';
import type { RouteDef } from './routes.js';
import { McpServer, RiskClass, ToolStatus } from './tools.js';

/**
 * AI power tools (D10, G04, G17): signing in to MCP servers with OAuth, what they list besides
 * tools, the catalog of services, Hamnivo's own MCP server, websites as knowledge, the "Test your
 * AI" playground and custom HTTP tools. Everything a server or a website says is untrusted text
 * and is shown quoted.
 */

const serverParams = z.object({
  serverId: z.string().meta({ description: 'MCP server ID (mcp_…)' }),
});

// ── MCP servers: catalog of services ─────────────────────────────────────────────────────

export const McpPresetAuth = z.enum(['oauth', 'oauth_or_token', 'token']).meta({
  id: 'McpPresetAuth',
  description: '`oauth`: a browser sign-in. `token`: a pasted token. `oauth_or_token`: either.',
});

/** A remote MCP server that its vendor runs, from the vendor's own documentation. */
export const McpPreset = z
  .object({
    id: z.string(),
    name: z.string(),
    vendor: z.string(),
    url: z.string(),
    /** The vendor's page that names the address. */
    docsUrl: z.string(),
    category: z.enum(['support', 'commerce', 'work', 'engineering']),
    auth: McpPresetAuth,
    summary: z.string(),
    note: z.string().nullable(),
    /** The day the vendor's page was read. */
    verifiedOn: z.string(),
  })
  .meta({ id: 'McpPreset' });
export type McpPreset = z.infer<typeof McpPreset>;

// ── MCP servers: OAuth sign-in ───────────────────────────────────────────────────────────

/**
 * Starts a sign-in. Most services register Hamnivo themselves; for one that does not, enter the
 * client ID (and secret) the service gave you.
 */
export const StartMcpOAuthRequest = z
  .object({
    clientId: z.string().trim().min(1).max(300).optional(),
    clientSecret: z.string().trim().min(1).max(2000).optional(),
    /** Only when you know what to ask for; by default what the service says it needs. */
    scope: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.clientSecret && !value.clientId) {
      ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'A secret needs its client ID' });
    }
  })
  .meta({ id: 'StartMcpOAuthRequest' });

export const McpOAuthStart = z
  .object({
    /** Where to send the person's browser. */
    authorizationUrl: z.string(),
    /** The host it goes to, to show before it goes. */
    authorizationHost: z.string(),
    /** The sign-in must be finished by then. */
    expiresAt: Timestamp,
  })
  .meta({ id: 'McpOAuthStart' });
export type McpOAuthStart = z.infer<typeof McpOAuthStart>;

/**
 * What the authorization server sent the browser back with. `state` finds the sign-in; only the
 * person who started it can finish it.
 */
export const CompleteMcpOAuthRequest = z
  .object({
    state: z.string().trim().min(16).max(200),
    code: z.string().min(1).max(4000).optional(),
    error: z.string().max(200).optional(),
    errorDescription: z.string().max(500).optional(),
    /** The issuer the authorization server says answered (RFC 9207), when it says. */
    iss: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.code && !value.error) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: 'Send the code or the error' });
    }
  })
  .meta({ id: 'CompleteMcpOAuthRequest' });

// ── MCP servers: what they list besides tools ────────────────────────────────────────────

export const McpCatalogResource = z
  .object({
    id: typeId('mcpItem'),
    uri: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    /** What the server said: untrusted, shown quoted. */
    description: z.string().nullable(),
    mimeType: z.string().nullable(),
    sizeBytes: z.int().nullable(),
    /** Agents with the "Read a resource" tool may read it. */
    aiReadable: z.boolean(),
  })
  .meta({ id: 'McpCatalogResource' });
export type McpCatalogResource = z.infer<typeof McpCatalogResource>;

export const McpCatalogPrompt = z
  .object({
    id: typeId('mcpItem'),
    name: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    arguments: z.array(
      z.object({ name: z.string(), description: z.string().nullable(), required: z.boolean() }),
    ),
  })
  .meta({ id: 'McpCatalogPrompt' });
export type McpCatalogPrompt = z.infer<typeof McpCatalogPrompt>;

/** What a server listed at its last sync, besides its tools. */
export const McpCatalog = z
  .object({
    resources: z.array(McpCatalogResource),
    prompts: z.array(McpCatalogPrompt),
    /** When the server was last listed; null before the first sync. */
    syncedAt: Timestamp.nullable(),
  })
  .meta({ id: 'McpCatalog' });
export type McpCatalog = z.infer<typeof McpCatalog>;

export const UpdateMcpResourceRequest = z
  .object({ aiReadable: z.boolean() })
  .meta({ id: 'UpdateMcpResourceRequest' });

// ── Websites as knowledge ────────────────────────────────────────────────────────────────

export const WebSyncMode = z.enum(['page', 'site']).meta({
  id: 'WebSyncMode',
  description:
    '`page`: just the address given. `site`: its sitemap and the links between its pages, within the limits.',
});
export const WebSyncSchedule = z.enum(['manual', 'daily', 'weekly']).meta({
  id: 'WebSyncSchedule',
  description: 'How often the website is read again; `manual` only when someone asks.',
});
export const WebSyncState = z.enum(['idle', 'queued', 'running']).meta({ id: 'WebSyncState' });
export const WebSyncResult = z
  .enum(['succeeded', 'partial', 'failed'])
  .meta({ id: 'WebSyncResult' });
export type WebSyncMode = z.infer<typeof WebSyncMode>;
export type WebSyncSchedule = z.infer<typeof WebSyncSchedule>;
export type WebSyncState = z.infer<typeof WebSyncState>;
export type WebSyncResult = z.infer<typeof WebSyncResult>;

/** What the last read of a website did: counts and short reasons, never page content. */
export const WebSyncSummary = z
  .object({
    startedAt: Timestamp,
    finishedAt: Timestamp,
    /** Pages read and kept. */
    pages: z.int(),
    added: z.int(),
    updated: z.int(),
    unchanged: z.int(),
    /** Pages that were there before and are not any more (their documents are retired). */
    retired: z.int(),
    /** Left out, by reason. */
    skipped: z.object({
      robots: z.int(),
      offsite: z.int(),
      noindex: z.int(),
      type: z.int(),
      duplicate: z.int(),
      empty: z.int(),
    }),
    /** Why the pages that failed did, for the first few. */
    problems: z.array(z.object({ url: z.string(), reason: z.string() })),
    /** The page limit or the time limit stopped the read before it was through. */
    truncated: z.boolean(),
    /** What the site's robots.txt said: read, not there, or could not be read. */
    robots: z.enum(['read', 'missing', 'unreadable']),
    sitemaps: z.int(),
  })
  .meta({ id: 'WebSyncSummary' });
export type WebSyncSummary = z.infer<typeof WebSyncSummary>;

/** A website kept as a knowledge source: where it starts, how far it goes, when it is read again. */
export const KnowledgeWebSource = z
  .object({
    id: typeId('webSource'),
    sourceId: typeId('source'),
    brandId: typeId('brand'),
    name: z.string(),
    visibility: KnowledgeVisibility,
    status: z.enum(['active', 'paused', 'retired']),
    url: z.string(),
    mode: WebSyncMode,
    maxPages: z.int(),
    maxDepth: z.int(),
    schedule: WebSyncSchedule,
    state: WebSyncState,
    nextRunAt: Timestamp.nullable(),
    lastRunAt: Timestamp.nullable(),
    lastResult: WebSyncResult.nullable(),
    lastRun: WebSyncSummary.nullable(),
    /** Pages that are currently documents of the source. */
    pageCount: z.int(),
    createdAt: Timestamp,
  })
  .meta({ id: 'KnowledgeWebSource' });
export type KnowledgeWebSource = z.infer<typeof KnowledgeWebSource>;

/** Add a website: a knowledge source whose documents are its pages. */
export const CreateWebSourceRequest = z
  .object({
    brandId: typeId('brand'),
    url: z.url({ protocol: /^https?$/ }).max(500),
    /** Defaults to the website's host name. */
    name: z.string().trim().min(1).max(120).optional(),
    mode: WebSyncMode.default('site'),
    maxPages: z.int().min(1).max(500).default(50),
    maxDepth: z.int().min(0).max(5).default(2),
    schedule: WebSyncSchedule.default('weekly'),
    visibility: KnowledgeVisibility.default('public'),
  })
  .meta({ id: 'CreateWebSourceRequest' });

export const UpdateWebSourceRequest = z
  .object({
    mode: WebSyncMode.optional(),
    maxPages: z.int().min(1).max(500).optional(),
    maxDepth: z.int().min(0).max(5).optional(),
    schedule: WebSyncSchedule.optional(),
  })
  .meta({ id: 'UpdateWebSourceRequest' });

export const KnowledgeWebPage = z
  .object({
    url: z.string(),
    documentId: typeId('document').nullable(),
    /** `ok`: read at the last sync. `failed`: could not be read. `gone`: not there any more. */
    state: z.enum(['ok', 'failed', 'gone']),
    /** The HTTP status of the last request, when there was one. */
    status: z.int().nullable(),
    lastFetchedAt: Timestamp.nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'KnowledgeWebPage' });
export type KnowledgeWebPage = z.infer<typeof KnowledgeWebPage>;

const webSourceParams = z.object({
  webSourceId: z.string().meta({ description: 'Website source ID (wsrc_…)' }),
});

// ── Test your AI ─────────────────────────────────────────────────────────────────────────

const agentParams = z.object({ agentId: z.string().meta({ description: 'Agent ID (agt_…)' }) });

export const PlaygroundVersion = z.enum(['draft', 'published']).meta({
  id: 'PlaygroundVersion',
  description: 'Which version of the agent to try: the saved draft, or the one that is live.',
});

export const PlaygroundMessage = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(2000),
  })
  .meta({ id: 'PlaygroundMessage' });

/**
 * One turn of a scratch conversation. The conversation is kept by the person testing, not by
 * Hamnivo: it is sent whole each time, nothing of it is stored, and no customer, no earlier
 * conversation and no memory is in it.
 */
export const PlaygroundRequest = z
  .object({
    version: PlaygroundVersion.default('draft'),
    messages: z
      .array(PlaygroundMessage)
      .min(1)
      .max(20)
      .refine((messages) => messages.at(-1)?.role === 'user', {
        message: 'The last message must be the one being tested.',
      }),
  })
  .meta({ id: 'PlaygroundRequest' });

/** A passage of the knowledge base the reply cites. */
export const PlaygroundSource = z
  .object({
    documentId: typeId('document'),
    title: z.string(),
    heading: z.string().nullable(),
    url: z.string().nullable(),
    excerpt: z.string(),
  })
  .meta({ id: 'PlaygroundSource' });

/** A tool the AI asked for: what the live rules would do with it. Nothing is ever run. */
export const PlaygroundAction = z
  .object({
    tool: z.string(),
    title: z.string(),
    /**
     * `would_run`: it would run at once in a live chat. `needs_approval`: someone would be asked
     * first. `denied`: the rules refuse it. `invalid`: the AI sent arguments the tool does not take.
     */
    decision: z.enum(['would_run', 'needs_approval', 'denied', 'invalid']),
    reason: z.string().nullable(),
    arguments: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: 'PlaygroundAction' });

export const PlaygroundResult = z
  .object({
    outcome: z.enum(['replied', 'handoff', 'blocked', 'error']),
    /** What the AI would say to the customer (citation numbers already checked). */
    reply: z.string().nullable(),
    /** Why a live chat would go to a person, with the live reasons. */
    handoffReason: z.string().nullable(),
    /** What went wrong when the outcome is `error`, in the words runs record. */
    errorKind: z.string().nullable(),
    version: z.object({ number: z.int().positive(), state: PlaygroundVersion }),
    /** The model that answered: the agent's own choice or one of its fallbacks. */
    model: z.object({ provider: z.string(), modelId: z.string() }).nullable(),
    inputTokens: z.int().nullable(),
    outputTokens: z.int().nullable(),
    latencyMs: z.int(),
    sources: z.array(PlaygroundSource),
    actions: z.array(PlaygroundAction),
    /** What happened, in order, as a live run records it. */
    steps: z.array(RunStep),
  })
  .meta({ id: 'PlaygroundResult' });
export type PlaygroundSource = z.infer<typeof PlaygroundSource>;
export type PlaygroundAction = z.infer<typeof PlaygroundAction>;
export type PlaygroundStep = z.infer<typeof RunStep>;
export type PlaygroundResult = z.infer<typeof PlaygroundResult>;

/** The memory customer behind a conversation, so Studio can show what is remembered. */
export const ConversationMemoryCustomer = z
  .object({
    /** The customer whose memory the conversation's customer is, or none (an unknown visitor). */
    customerId: typeId('customer').nullable(),
  })
  .meta({ id: 'ConversationMemoryCustomer' });
export type ConversationMemoryCustomer = z.infer<typeof ConversationMemoryCustomer>;

// ── Custom HTTP tools ────────────────────────────────────────────────────────────────────

/** The largest OpenAPI description Studio sends or Hamnivo reads, in characters. */
export const HTTP_SPEC_MAX_CHARS = 900_000;

export const HttpToolMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).meta({
  id: 'HttpToolMethod',
  description: 'The request method of a custom HTTP tool.',
});
export const HttpToolArgumentIn = z.enum(['path', 'query', 'header', 'body']).meta({
  id: 'HttpToolArgumentIn',
  description:
    'Where an argument goes in the request: the address path, the query string, a header, or a field of the JSON body.',
});
export const HttpToolArgumentType = z
  .enum(['string', 'integer', 'number', 'boolean'])
  .meta({ id: 'HttpToolArgumentType' });
export const HttpToolAuthKind = z.enum(['none', 'bearer', 'header']).meta({
  id: 'HttpToolAuthKind',
  description:
    '`bearer`: a token sent as `Authorization: Bearer …`. `header`: a secret value sent in a header of your choice.',
});
export type HttpToolMethod = z.infer<typeof HttpToolMethod>;
export type HttpToolArgumentIn = z.infer<typeof HttpToolArgumentIn>;
export type HttpToolAuthKind = z.infer<typeof HttpToolAuthKind>;

const HttpHeaderName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, hyphens and underscores');

/** What the tools of a source send as their credential. It is stored in the secret broker. */
export const HttpToolAuthInput = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('bearer'), token: z.string().trim().min(8).max(4000) }),
    z.object({
      kind: z.literal('header'),
      header: HttpHeaderName,
      value: z.string().trim().min(1).max(4000),
    }),
  ])
  .meta({ id: 'HttpToolAuthInput' });

/** One argument of a tool written by hand: its name, where it goes and what it is. */
export const HttpToolArgumentInput = z
  .object({
    /** What the AI calls it. */
    name: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
        'Letters, digits and underscores, starting with a letter',
      ),
    in: HttpToolArgumentIn,
    /** The name in the request, when it is not the argument's own name. */
    key: z.string().trim().min(1).max(100).optional(),
    type: HttpToolArgumentType.default('string'),
    required: z.boolean().default(false),
    description: z.string().trim().max(300).optional(),
  })
  .meta({ id: 'HttpToolArgumentInput' });

/** One request written by hand: the address path (with `{placeholders}`), method and arguments. */
export const HttpEndpointInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** What the AI is told the tool does. */
    description: z.string().trim().min(1).max(1000),
    method: HttpToolMethod,
    /** Starts with `/`; `{orderId}` is filled in from the argument of that name. */
    path: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/{}]*$/, 'Start with / and leave out ? and #'),
    arguments: z.array(HttpToolArgumentInput).max(20).default([]),
    /** By default from the method: GET reads, DELETE cannot be undone, the others change something. */
    risk: RiskClass.optional(),
  })
  .meta({ id: 'HttpEndpointInput' });

const onlyOne = (value: { spec?: string | undefined; specUrl?: string | undefined }) =>
  Number(value.spec !== undefined) + Number(value.specUrl !== undefined) === 1;

/** The operations of an OpenAPI description to turn into tools, named as the preview names them. */
export const HttpOpenApiImport = z
  .object({
    spec: z.string().min(2).max(HTTP_SPEC_MAX_CHARS).optional(),
    specUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    /** The hash the preview of a description read from an address gave; a changed one is refused. */
    specHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** `GET /orders/{orderId}` and so on, as listed by the preview. */
    operations: z.array(z.string().max(400)).min(1).max(100),
  })
  .refine(onlyOne, { message: 'Send the description or its address' })
  .meta({ id: 'HttpOpenApiImport' });

/** Read an OpenAPI 3 description and list what could become tools. Nothing is saved. */
export const PreviewHttpSpecRequest = z
  .object({
    spec: z.string().min(2).max(HTTP_SPEC_MAX_CHARS).optional(),
    specUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    /** When adding to a service that is there, so the operations it already has are marked. */
    sourceId: typeId('httpSource').optional(),
  })
  .refine(onlyOne, { message: 'Send the description or its address' })
  .meta({ id: 'PreviewHttpSpecRequest' });

export const HttpOperationArgument = z
  .object({
    name: z.string(),
    in: HttpToolArgumentIn,
    type: z.string(),
    required: z.boolean(),
  })
  .meta({ id: 'HttpOperationArgument' });

/** One operation of a description, as it would become a tool. */
export const HttpOperationPreview = z
  .object({
    /** `GET /orders/{orderId}`: how an import names it. */
    key: z.string(),
    method: HttpToolMethod,
    path: z.string(),
    /** What the description called it (untrusted text). */
    title: z.string(),
    /** What the description said about it (untrusted text, shown quoted). */
    summary: z.string().nullable(),
    /** The name the tool would get. */
    toolName: z.string(),
    risk: RiskClass,
    arguments: z.array(HttpOperationArgument),
    /** What was left out of it, and why. */
    notes: z.array(z.string()),
    /** The service already has a tool for it (only when adding to a service that is there). */
    imported: z.boolean(),
  })
  .meta({ id: 'HttpOperationPreview' });

export const HttpSpecPreview = z
  .object({
    /** The version of the OpenAPI standard the description follows. */
    openapi: z.string(),
    title: z.string().nullable(),
    version: z.string().nullable(),
    /** SHA-256 of the text that was read. */
    hash: z.string(),
    /** The addresses the description says the service is at (untrusted: check before using). */
    servers: z.array(z.string()),
    /** How the description says the service wants to be called, when Hamnivo can do it. */
    auth: z.object({
      kind: HttpToolAuthKind,
      header: z.string().nullable(),
      /** A kind of sign-in the description asks for that tools cannot use (`oauth2`, `basic`…). */
      unsupported: z.string().nullable(),
    }),
    operations: z.array(HttpOperationPreview),
    /** Operations that cannot become tools, and why. */
    skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
  })
  .meta({ id: 'HttpSpecPreview' });
export type HttpSpecPreview = z.infer<typeof HttpSpecPreview>;
export type HttpOperationPreview = z.infer<typeof HttpOperationPreview>;

const HttpSourceName = z.string().trim().min(1).max(80);
const HttpBaseUrl = z.url({ protocol: /^https?$/ }).max(500);

const exactlyOneWay = (value: { openapi?: unknown; endpoint?: unknown }) =>
  Number(value.openapi !== undefined) + Number(value.endpoint !== undefined) === 1;

/**
 * Adds a service with its tools: an OpenAPI description (the chosen operations) or one request
 * written by hand. The tools start in review, like tools from an MCP server.
 */
export const CreateHttpSourceRequest = z
  .object({
    brandId: typeId('brand'),
    name: HttpSourceName,
    /** Every call goes below this address; its host is the only one the tools may reach. */
    baseUrl: HttpBaseUrl,
    auth: HttpToolAuthInput.default({ kind: 'none' }),
    openapi: HttpOpenApiImport.optional(),
    endpoint: HttpEndpointInput.optional(),
  })
  .refine(exactlyOneWay, { message: 'Send an OpenAPI import or one request written by hand' })
  .meta({ id: 'CreateHttpSourceRequest' });

/** More tools for a service that is already there. */
export const AddHttpEndpointsRequest = z
  .object({
    openapi: HttpOpenApiImport.optional(),
    endpoint: HttpEndpointInput.optional(),
  })
  .refine(exactlyOneWay, { message: 'Send an OpenAPI import or one request written by hand' })
  .meta({ id: 'AddHttpEndpointsRequest' });

export const UpdateHttpSourceRequest = z
  .object({
    name: HttpSourceName.optional(),
    baseUrl: HttpBaseUrl.optional(),
    /** Replaces the credential; `none` removes it. */
    auth: HttpToolAuthInput.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .meta({ id: 'UpdateHttpSourceRequest' });

/** Replaces a request written by hand; the tool goes back to review. */
export const UpdateHttpEndpointRequest = HttpEndpointInput.extend({
  expectedRevision: z.int().positive(),
}).meta({ id: 'UpdateHttpEndpointRequest' });

export const HttpToolArgument = z
  .object({
    name: z.string(),
    in: HttpToolArgumentIn,
    /** The name in the request. */
    key: z.string(),
    required: z.boolean(),
    /** `string`, `integer`, `number`, `boolean`, `array` or `object`. */
    type: z.string(),
    description: z.string().nullable(),
  })
  .meta({ id: 'HttpToolArgument' });

export const HttpToolEndpoint = z
  .object({
    toolId: typeId('tool'),
    toolName: z.string(),
    title: z.string(),
    /** What the AI is told the tool does. */
    description: z.string(),
    method: HttpToolMethod,
    path: z.string(),
    risk: RiskClass,
    status: ToolStatus,
    revision: z.int().positive(),
    /** Written by hand, so it can be edited here. An imported one is changed by importing again. */
    editable: z.boolean(),
    arguments: z.array(HttpToolArgument),
  })
  .meta({ id: 'HttpToolEndpoint' });
export type HttpToolEndpoint = z.infer<typeof HttpToolEndpoint>;

/** A service whose requests are tools: its address, how it is signed in to, and its tools. */
export const HttpToolSource = z
  .object({
    id: typeId('httpSource'),
    brandId: typeId('brand'),
    name: z.string(),
    kind: z.enum(['openapi', 'manual']),
    baseUrl: z.string(),
    auth: z.object({
      kind: HttpToolAuthKind,
      header: z.string().nullable(),
      /** The last characters of the credential; never more. */
      masked: z.string().nullable(),
    }),
    /** What the imported description called itself (untrusted text). */
    specTitle: z.string().nullable(),
    specVersion: z.string().nullable(),
    status: z.enum(['active', 'disabled']),
    endpoints: z.array(HttpToolEndpoint),
    createdAt: Timestamp,
  })
  .meta({ id: 'HttpToolSource' });
export type HttpToolSource = z.infer<typeof HttpToolSource>;

const httpSourceParams = z.object({
  sourceId: z.string().meta({ description: 'Custom tool source ID (hsrc_…)' }),
});

// ── Hamnivo's own MCP server ─────────────────────────────────────────────────────────────

/** A JSON-RPC 2.0 message of the Model Context Protocol (Streamable HTTP, no sessions). */
export const McpMessage = z
  .record(z.string(), z.unknown())
  .meta({ id: 'McpMessage', description: 'A JSON-RPC 2.0 request, notification or response.' });

export const aiPowerRoutes = {
  mcpServer: {
    method: 'post',
    path: '/mcp',
    operationId: 'postMcp',
    summary:
      'Hamnivo’s own MCP server (Streamable HTTP, JSON-RPC): read-only tools for AI assistants such as Claude, called with an API key that holds mcp.read',
    tags: ['MCP'],
    auth: 'api_key',
    body: McpMessage,
    success: { status: 200, description: 'The JSON-RPC answer', schema: McpMessage },
  },
  listMcpPresets: {
    method: 'get',
    path: '/v1/admin/mcp-presets',
    operationId: 'listMcpPresets',
    summary:
      'Remote MCP servers that vendors run themselves, with the vendor page that names each address (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Services',
      schema: z.object({ items: z.array(McpPreset) }),
    },
  },
  deleteMcpServer: {
    method: 'delete',
    path: '/v1/admin/mcp-servers/{serverId}',
    operationId: 'deleteMcpServer',
    summary:
      'Remove an MCP server: its tools are turned off, its credentials are revoked and it leaves the list; connecting the same address again starts fresh (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    success: { status: 204, description: 'Removed' },
  },
  startMcpOAuth: {
    method: 'post',
    path: '/v1/admin/mcp-servers/{serverId}/oauth/start',
    operationId: 'startMcpOAuth',
    summary:
      'Begin signing in to an MCP server with OAuth: returns the address to send the browser to (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    body: StartMcpOAuthRequest,
    success: { status: 200, description: 'Where to sign in', schema: McpOAuthStart },
  },
  completeMcpOAuth: {
    method: 'post',
    path: '/v1/admin/mcp-oauth/complete',
    operationId: 'completeMcpOAuth',
    summary:
      'Finish a sign-in with what the browser came back with; only the person who started it can (tools.manage)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: CompleteMcpOAuthRequest,
    success: { status: 200, description: 'Signed in', schema: McpServer },
  },
  disconnectMcpOAuth: {
    method: 'post',
    path: '/v1/admin/mcp-servers/{serverId}/oauth/disconnect',
    operationId: 'disconnectMcpOAuth',
    summary:
      'Sign out of an MCP server: its tokens are revoked and dropped (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    success: { status: 200, description: 'Server', schema: McpServer },
  },
  getMcpCatalog: {
    method: 'get',
    path: '/v1/admin/mcp-servers/{serverId}/catalog',
    operationId: 'getMcpCatalog',
    summary: 'The resources and prompts a server listed at its last sync (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams,
    success: { status: 200, description: 'Catalog', schema: McpCatalog },
  },
  updateMcpResource: {
    method: 'patch',
    path: '/v1/admin/mcp-servers/{serverId}/resources/{itemId}',
    operationId: 'updateMcpResource',
    summary:
      'Let agents with the "Read a resource" tool read this resource, or stop them (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: serverParams.extend({
      itemId: z.string().meta({ description: 'Resource ID (mci_…)' }),
    }),
    body: UpdateMcpResourceRequest,
    success: { status: 200, description: 'Resource', schema: McpCatalogResource },
  },
  listWebSources: {
    method: 'get',
    path: '/v1/admin/knowledge/web-sources',
    operationId: 'listWebSources',
    summary: 'Websites kept as knowledge, with how their last read went (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Websites',
      schema: z.object({ items: z.array(KnowledgeWebSource) }),
    },
  },
  createWebSource: {
    method: 'post',
    path: '/v1/admin/knowledge/web-sources',
    operationId: 'createWebSource',
    summary:
      'Add a website as knowledge: Hamnivo reads its pages (sitemap, same site, robots.txt respected) and keeps them up to date (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    body: CreateWebSourceRequest,
    idempotent: true,
    success: { status: 201, description: 'Website added', schema: KnowledgeWebSource },
  },
  updateWebSource: {
    method: 'patch',
    path: '/v1/admin/knowledge/web-sources/{webSourceId}',
    operationId: 'updateWebSource',
    summary: 'Change what a website source reads and how often (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: webSourceParams,
    body: UpdateWebSourceRequest,
    success: { status: 200, description: 'Website', schema: KnowledgeWebSource },
  },
  syncWebSource: {
    method: 'post',
    path: '/v1/admin/knowledge/web-sources/{webSourceId}/sync',
    operationId: 'syncWebSource',
    summary: 'Read the website again now (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: webSourceParams,
    success: { status: 202, description: 'Queued', schema: KnowledgeWebSource },
  },
  listWebPages: {
    method: 'get',
    path: '/v1/admin/knowledge/web-sources/{webSourceId}/pages',
    operationId: 'listWebPages',
    summary:
      'The pages of a website source and what the last read said about each (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: webSourceParams,
    success: {
      status: 200,
      description: 'Pages',
      schema: z.object({ items: z.array(KnowledgeWebPage) }),
    },
  },
  runAgentPlayground: {
    method: 'post',
    path: '/v1/admin/agents/{agentId}/playground',
    operationId: 'runAgentPlayground',
    summary:
      'Try an agent in a scratch conversation with its own model connection: nothing is stored, nothing reaches a customer or Chatwoot, and no tool is run (agents.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: agentParams,
    body: PlaygroundRequest,
    success: { status: 200, description: 'What the AI would do', schema: PlaygroundResult },
  },
  getConversationMemoryCustomer: {
    method: 'get',
    path: '/v1/admin/memory/conversations/{conversationId}',
    operationId: 'getConversationMemoryCustomer',
    summary:
      'The memory customer of a conversation, for the inbox panel (conversations.read and memory.read)',
    tags: ['Memory'],
    auth: 'staff_session',
    params: z.object({
      conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
    }),
    success: {
      status: 200,
      description: 'Memory customer',
      schema: ConversationMemoryCustomer,
    },
  },
  listHttpToolSources: {
    method: 'get',
    path: '/v1/admin/http-tools/sources',
    operationId: 'listHttpToolSources',
    summary: 'Services whose requests are custom HTTP tools, with their tools (tools.read)',
    tags: ['Tools'],
    auth: 'staff_session',
    query: z.object({ brandId: z.string().optional() }),
    success: {
      status: 200,
      description: 'Services',
      schema: z.object({ items: z.array(HttpToolSource) }),
    },
  },
  previewHttpSpec: {
    method: 'post',
    path: '/v1/admin/http-tools/preview',
    operationId: 'previewHttpSpec',
    summary:
      'Read an OpenAPI 3 description (pasted, or fetched from an address through the egress guard) and list the tools it could become; nothing is saved (tools.manage)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: PreviewHttpSpecRequest,
    success: { status: 200, description: 'What was found', schema: HttpSpecPreview },
  },
  createHttpToolSource: {
    method: 'post',
    path: '/v1/admin/http-tools/sources',
    operationId: 'createHttpToolSource',
    summary:
      'Add a service with custom HTTP tools, from chosen operations of an OpenAPI description or one request written by hand; the tools start in review and its credential goes to the secret broker (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    body: CreateHttpSourceRequest,
    idempotent: true,
    success: { status: 201, description: 'Service added', schema: HttpToolSource },
  },
  updateHttpToolSource: {
    method: 'patch',
    path: '/v1/admin/http-tools/sources/{sourceId}',
    operationId: 'updateHttpToolSource',
    summary:
      'Rename a service, change its address, replace its credential or turn it off (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: httpSourceParams,
    body: UpdateHttpSourceRequest,
    success: { status: 200, description: 'Service', schema: HttpToolSource },
  },
  deleteHttpToolSource: {
    method: 'delete',
    path: '/v1/admin/http-tools/sources/{sourceId}',
    operationId: 'deleteHttpToolSource',
    summary:
      'Remove a service: its tools are turned off, pending requests are cancelled and its credential is revoked; what its tools did stays on record (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: httpSourceParams,
    success: { status: 204, description: 'Removed' },
  },
  addHttpToolEndpoints: {
    method: 'post',
    path: '/v1/admin/http-tools/sources/{sourceId}/endpoints',
    operationId: 'addHttpToolEndpoints',
    summary:
      'Add more tools to a service: operations of an OpenAPI description, or one request written by hand; they start in review (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: httpSourceParams,
    body: AddHttpEndpointsRequest,
    idempotent: true,
    success: { status: 201, description: 'Service with the new tools', schema: HttpToolSource },
  },
  updateHttpToolEndpoint: {
    method: 'put',
    path: '/v1/admin/http-tools/sources/{sourceId}/endpoints/{toolId}',
    operationId: 'updateHttpToolEndpoint',
    summary:
      'Replace a request written by hand; the tool goes back to review and requests waiting on it are cancelled (tools.manage, fresh sign-in)',
    tags: ['Tools'],
    auth: 'staff_session',
    params: httpSourceParams.extend({
      toolId: z.string().meta({ description: 'Tool ID (tool_…)' }),
    }),
    body: UpdateHttpEndpointRequest,
    success: { status: 200, description: 'Service', schema: HttpToolSource },
  },
} as const satisfies Record<string, RouteDef>;
