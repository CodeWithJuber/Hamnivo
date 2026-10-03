import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { mcpServers, toolDefinitions } from './actions.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { secrets, staffMembers } from './identity.js';
import { knowledgeDocuments, knowledgeSources } from './knowledge.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/**
 * AI power tools (D10, G04, G17): signing in to remote MCP servers with OAuth, what those servers
 * offer besides tools (resources and prompts), custom HTTP tools, and websites as knowledge.
 * Every credential lives in `secrets`; these tables only hold references and what is safe to show.
 */

export const MCP_OAUTH_STATUSES = ['connected', 'needs_reconnect'] as const;
export const MCP_CATALOG_KINDS = ['resource', 'prompt'] as const;
export const HTTP_TOOL_SOURCE_KINDS = ['openapi', 'manual'] as const;
export const HTTP_TOOL_AUTH_KINDS = ['none', 'bearer', 'header'] as const;
export const HTTP_TOOL_SOURCE_STATUSES = ['active', 'disabled', 'deleted'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const WEB_SYNC_MODES = ['page', 'site'] as const;
export const WEB_SYNC_SCHEDULES = ['manual', 'daily', 'weekly'] as const;
export const WEB_SYNC_STATES = ['idle', 'queued', 'running'] as const;
export const WEB_SYNC_RESULTS = ['succeeded', 'partial', 'failed'] as const;

/** What one HTTP tool argument becomes in the request. */
export interface HttpToolParameter {
  /** The name on the wire (`orderId` in `/orders/{orderId}`, a query or header name). */
  name: string;
  in: 'path' | 'query' | 'header';
  /** The tool argument that supplies it. */
  argument: string;
  required: boolean;
}

/** A tool argument that becomes a top-level field of the JSON request body. */
export interface HttpToolBodyField {
  argument: string;
  key: string;
}

/**
 * The sign-in of an MCP server that uses OAuth (the MCP authorization spec). The access token is
 * the server's own `token_secret_id`, so everything that already sends a server's token keeps
 * working; the refresh token and the client registration are secrets of their own. A server has
 * either a pasted token or this, never both.
 */
export const mcpServerOauth = pgTable(
  'mcp_server_oauth',
  {
    id: id(),
    tenantId: tenantId(),
    mcpServerId: uuid('mcp_server_id').notNull(),
    status: text('status', { enum: MCP_OAUTH_STATUSES }).notNull().default('connected'),
    /** The authorization server's URL as discovery found it (what stored credentials bind to). */
    authorizationServer: text('authorization_server').notNull(),
    /** The RFC 8707 resource indicator sent with the sign-in and every refresh. */
    resource: text('resource').notNull(),
    clientId: text('client_id').notNull(),
    /** `dynamic`: registered by Hamnivo (RFC 7591). `manual`: entered by a person. */
    registration: text('registration', { enum: ['dynamic', 'manual'] }).notNull(),
    /** Secret: the client's registration (it may hold a client secret). */
    clientSecretId: uuid('client_secret_id').notNull(),
    /** Secret: the refresh token, when the authorization server issued one. */
    refreshSecretId: uuid('refresh_secret_id'),
    scope: text('scope'),
    /** Where the authorization server and the protected resource metadata were found. */
    discovery: jsonb('discovery').$type<Record<string, unknown>>().notNull().default({}),
    accessExpiresAt: tstz('access_expires_at'),
    connectedBy: uuid('connected_by'),
    connectedAt: tstz('connected_at').notNull().defaultNow(),
    lastRefreshedAt: tstz('last_refreshed_at'),
    /** Why the sign-in needs attention, in safe words (never a response body). */
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_server_oauth_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('mcp_server_oauth_server_key').on(t.tenantId, t.mcpServerId),
    foreignKey({
      name: 'mcp_server_oauth_server_fk',
      columns: [t.tenantId, t.mcpServerId],
      foreignColumns: [mcpServers.tenantId, mcpServers.id],
    }),
    foreignKey({
      name: 'mcp_server_oauth_client_secret_fk',
      columns: [t.tenantId, t.clientSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'mcp_server_oauth_refresh_secret_fk',
      columns: [t.tenantId, t.refreshSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'mcp_server_oauth_connected_by_fk',
      columns: [t.tenantId, t.connectedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * A sign-in that has started and not finished: the state the authorization server will send back,
 * the PKCE verifier and the client registration (both secrets), and who started it. It ends when
 * the person comes back (used once), or after ten minutes.
 */
export const mcpOauthAttempts = pgTable(
  'mcp_oauth_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    mcpServerId: uuid('mcp_server_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    /** SHA-256 of the `state` value; the value itself is only in the browser's address. */
    stateHash: bytea('state_hash').notNull(),
    verifierSecretId: uuid('verifier_secret_id').notNull(),
    clientSecretId: uuid('client_secret_id').notNull(),
    clientId: text('client_id').notNull(),
    registration: text('registration', { enum: ['dynamic', 'manual'] }).notNull(),
    authorizationServer: text('authorization_server').notNull(),
    resource: text('resource').notNull(),
    scope: text('scope'),
    discovery: jsonb('discovery').$type<Record<string, unknown>>().notNull().default({}),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mcp_oauth_attempts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('mcp_oauth_attempts_state_key').on(t.tenantId, t.stateHash),
    index('mcp_oauth_attempts_server_idx').on(t.tenantId, t.mcpServerId),
    foreignKey({
      name: 'mcp_oauth_attempts_server_fk',
      columns: [t.tenantId, t.mcpServerId],
      foreignColumns: [mcpServers.tenantId, mcpServers.id],
    }),
    foreignKey({
      name: 'mcp_oauth_attempts_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'mcp_oauth_attempts_verifier_fk',
      columns: [t.tenantId, t.verifierSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'mcp_oauth_attempts_client_fk',
      columns: [t.tenantId, t.clientSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    check('mcp_oauth_attempts_hash_ck', sql`octet_length(${t.stateHash}) = 32`),
    tenantIsolation(),
  ],
);

/**
 * What an MCP server lists besides tools, as of the last sync: resources (`key` is the URI) and
 * prompts (`key` is the name). Everything the server says is untrusted text, shown quoted. An
 * agent may read a resource only when a person turned `ai_readable` on for it.
 */
export const mcpCatalogItems = pgTable(
  'mcp_catalog_items',
  {
    id: id(),
    tenantId: tenantId(),
    mcpServerId: uuid('mcp_server_id').notNull(),
    kind: text('kind', { enum: MCP_CATALOG_KINDS }).notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    /** Prompts: the arguments they take. */
    arguments: jsonb('arguments').$type<Record<string, unknown>[]>(),
    aiReadable: boolean('ai_readable').notNull().default(false),
    listedAt: tstz('listed_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_catalog_items_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('mcp_catalog_items_key').on(t.tenantId, t.mcpServerId, t.kind, t.key),
    foreignKey({
      name: 'mcp_catalog_items_server_fk',
      columns: [t.tenantId, t.mcpServerId],
      foreignColumns: [mcpServers.tenantId, mcpServers.id],
    }),
    check('mcp_catalog_items_ai_ck', sql`not ${t.aiReadable} or ${t.kind} = 'resource'`),
    tenantIsolation(),
  ],
);

/**
 * A set of custom HTTP tools that share one base address and one credential: an imported OpenAPI
 * description, or one endpoint written by hand. Its tools are ordinary tools (`source = 'http'`)
 * with Hamnivo's own descriptions; they start in review like tools from an MCP server.
 */
export const httpToolSources = pgTable(
  'http_tool_sources',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: HTTP_TOOL_SOURCE_KINDS }).notNull(),
    /** Every call goes to this address: HTTPS, public, on the workspace's allowed hosts. */
    baseUrl: text('base_url').notNull(),
    authKind: text('auth_kind', { enum: HTTP_TOOL_AUTH_KINDS }).notNull().default('none'),
    /** The header the credential travels in (`Authorization` for a bearer token). */
    authHeader: text('auth_header'),
    authSecretId: uuid('auth_secret_id'),
    /** The title and version the imported description gave itself (untrusted text). */
    specTitle: text('spec_title'),
    specVersion: text('spec_version'),
    specHash: bytea('spec_hash'),
    status: text('status', { enum: HTTP_TOOL_SOURCE_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('http_tool_sources_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('http_tool_sources_name_key')
      .on(t.tenantId, t.brandId, t.name)
      .where(sql`${t.status} <> 'deleted'`),
    foreignKey({
      name: 'http_tool_sources_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'http_tool_sources_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'http_tool_sources_auth_fk',
      columns: [t.tenantId, t.authSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'http_tool_sources_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('http_tool_sources_url_ck', sql`${t.baseUrl} ~ '^https?://'`),
    check('http_tool_sources_auth_ck', sql`(${t.authKind} = 'none') = (${t.authSecretId} is null)`),
    tenantIsolation(),
  ],
);

/** How one tool becomes one HTTP request: method, path, where each argument goes. */
export const httpToolEndpoints = pgTable(
  'http_tool_endpoints',
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid('source_id').notNull(),
    toolId: uuid('tool_id').notNull(),
    /** The operation's id in the imported description, to match a later import. */
    operationId: text('operation_id'),
    method: text('method', { enum: HTTP_METHODS }).notNull(),
    /** `/orders/{orderId}`: placeholders are filled from path parameters. */
    pathTemplate: text('path_template').notNull(),
    parameters: jsonb('parameters').$type<HttpToolParameter[]>().notNull().default([]),
    bodyMode: text('body_mode', { enum: ['none', 'json'] })
      .notNull()
      .default('none'),
    bodyFields: jsonb('body_fields').$type<HttpToolBodyField[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('http_tool_endpoints_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('http_tool_endpoints_tool_key').on(t.tenantId, t.toolId),
    uniqueIndex('http_tool_endpoints_route_key').on(
      t.tenantId,
      t.sourceId,
      t.method,
      t.pathTemplate,
    ),
    foreignKey({
      name: 'http_tool_endpoints_source_fk',
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [httpToolSources.tenantId, httpToolSources.id],
    }),
    foreignKey({
      name: 'http_tool_endpoints_tool_fk',
      columns: [t.tenantId, t.toolId],
      foreignColumns: [toolDefinitions.tenantId, toolDefinitions.id],
    }),
    check('http_tool_endpoints_path_ck', sql`${t.pathTemplate} ~ '^/'`),
    tenantIsolation(),
  ],
);

/**
 * A website kept as a knowledge source (G04, G17): where the crawl starts, how far it may go, and
 * when it runs again. The pages themselves are ordinary documents of the knowledge source.
 */
export const knowledgeWebSources = pgTable(
  'knowledge_web_sources',
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid('source_id').notNull(),
    startUrl: text('start_url').notNull(),
    /** `page`: just this address. `site`: its sitemap and the links on the same site. */
    mode: text('mode', { enum: WEB_SYNC_MODES }).notNull(),
    maxPages: integer('max_pages').notNull().default(50),
    maxDepth: integer('max_depth').notNull().default(2),
    schedule: text('schedule', { enum: WEB_SYNC_SCHEDULES }).notNull().default('manual'),
    nextRunAt: tstz('next_run_at'),
    state: text('state', { enum: WEB_SYNC_STATES }).notNull().default('idle'),
    /** A run that stops without finishing is picked up again once this time has passed. */
    leaseUntil: tstz('lease_until'),
    lastRunAt: tstz('last_run_at'),
    lastResult: text('last_result', { enum: WEB_SYNC_RESULTS }),
    /** Counts and short reasons for the last run, never page content. */
    lastRun: jsonb('last_run').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('knowledge_web_sources_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('knowledge_web_sources_source_key').on(t.tenantId, t.sourceId),
    index('knowledge_web_sources_due_idx').on(t.nextRunAt).where(sql`${t.schedule} <> 'manual'`),
    foreignKey({
      name: 'knowledge_web_sources_source_fk',
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
    foreignKey({
      name: 'knowledge_web_sources_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('knowledge_web_sources_url_ck', sql`${t.startUrl} ~ '^https?://'`),
    check(
      'knowledge_web_sources_limits_ck',
      sql`${t.maxPages} between 1 and 500 and ${t.maxDepth} between 0 and 5`,
    ),
    tenantIsolation(),
  ],
);

/** One page of a website source: its document, and what the last fetch said about it. */
export const knowledgeWebPages = pgTable(
  'knowledge_web_pages',
  {
    id: id(),
    tenantId: tenantId(),
    webSourceId: uuid('web_source_id').notNull(),
    url: text('url').notNull(),
    documentId: uuid('document_id'),
    depth: integer('depth').notNull().default(0),
    etag: text('etag'),
    lastModified: text('last_modified'),
    /** SHA-256 of the page's HTML, so an unchanged page adds no new version. */
    contentHash: bytea('content_hash'),
    lastFetchedAt: tstz('last_fetched_at'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    /** When the page was last missing (gone, or no longer linked); its document is retired. */
    goneAt: tstz('gone_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('knowledge_web_pages_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('knowledge_web_pages_url_key').on(t.tenantId, t.webSourceId, t.url),
    foreignKey({
      name: 'knowledge_web_pages_source_fk',
      columns: [t.tenantId, t.webSourceId],
      foreignColumns: [knowledgeWebSources.tenantId, knowledgeWebSources.id],
    }),
    foreignKey({
      name: 'knowledge_web_pages_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [knowledgeDocuments.tenantId, knowledgeDocuments.id],
    }),
    tenantIsolation(),
  ],
);
