import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';
import { McpServer } from './tools.js';

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

export const aiPowerRoutes = {
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
} as const satisfies Record<string, RouteDef>;
