import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { conversationControls } from './authority.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals, secrets, staffMembers } from './identity.js';
import { operations } from './operations.js';
import { agentProfiles, agentVersions, runs } from './runtime.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/**
 * AI actions (G07, G10, G11, G13–G15, D10): the tools a brand's agents may call, the remote MCP
 * servers some of them come from, every action the AI proposed with the exact arguments an
 * approver sees, the approvals people decided (append-only), handoff packets and simulation
 * suites. Consequential calls run through the operation ledger (`operations`), whose receipts are
 * the only evidence that an action happened.
 */

export const RISK_CLASSES = ['read', 'write', 'money', 'irreversible'] as const;
export const ACTION_APPROVERS = ['customer', 'staff'] as const;
export const TOOL_STATUSES = ['enabled', 'disabled', 'review'] as const;
export const BUILTIN_TOOLS = [
  'order_status',
  'demo_update_address',
  'demo_issue_credit',
  'read_resource',
] as const;

/**
 * A remote MCP server (Streamable HTTP only). Its bearer token lives in `secrets` (a pasted token,
 * or the access token of its OAuth sign-in, see `mcp_server_oauth`); its host is on the egress
 * allowlist of the tools it offers. What it says about itself is untrusted. The application never
 * deletes a server: `deleted` hides it, turns its tools off and revokes its credentials.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    status: text('status', { enum: ['active', 'disabled', 'deleted'] })
      .notNull()
      .default('active'),
    tokenSecretId: uuid('token_secret_id'),
    protocolVersion: text('protocol_version'),
    /** The name the server gave itself (untrusted, shown quoted). */
    serverName: text('server_name'),
    lastSyncedAt: tstz('last_synced_at'),
    lastError: text('last_error'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('mcp_servers_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('mcp_servers_brand_url_key').on(t.tenantId, t.brandId, t.url),
    foreignKey({
      name: 'mcp_servers_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'mcp_servers_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'mcp_servers_token_fk',
      columns: [t.tenantId, t.tokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'mcp_servers_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('mcp_servers_url_ck', sql`${t.url} ~ '^https?://'`),
    tenantIsolation(),
  ],
);

/**
 * A tool one brand's agents may be granted (G07): its input schema (portable subset), risk class,
 * approver, autopilot allowance, limits and egress hosts. Every policy change bumps `revision`,
 * which approvals are bound to. Tools discovered on an MCP server start in `review` and are
 * usable only after a person enables them (the reviewed allowlist, D10).
 */
export const toolDefinitions = pgTable(
  'tool_definitions',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    /** Name offered to the model; unique per brand. */
    name: text('name').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** What the MCP server or the imported API description said (untrusted, never sent as is). */
    remoteDescription: text('remote_description'),
    source: text('source', { enum: ['builtin', 'mcp', 'http', 'native'] }).notNull(),
    builtin: text('builtin', { enum: BUILTIN_TOOLS }),
    mcpServerId: uuid('mcp_server_id'),
    /** The tool's name on the MCP server. */
    remoteName: text('remote_name'),
    /** SHA-256 of what the server last listed for the tool, to notice changes. */
    remoteDigest: bytea('remote_digest'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    risk: text('risk', { enum: RISK_CLASSES }).notNull(),
    approver: text('approver', { enum: ACTION_APPROVERS }).notNull(),
    requiredPermission: text('required_permission'),
    autopilot: boolean('autopilot').notNull().default(false),
    customerStepUp: boolean('customer_step_up').notNull().default(false),
    resourceType: text('resource_type'),
    timeoutMs: integer('timeout_ms').notNull().default(10_000),
    maxOutputBytes: integer('max_output_bytes').notNull().default(16_384),
    egressHosts: text('egress_hosts').array().notNull().default(sql`'{}'::text[]`),
    amountArgument: text('amount_argument'),
    currencyArgument: text('currency_argument'),
    approvalMinutes: integer('approval_minutes'),
    status: text('status', { enum: TOOL_STATUSES }).notNull().default('enabled'),
    revision: integer('revision').notNull().default(1),
    reviewedAt: tstz('reviewed_at'),
    reviewedBy: uuid('reviewed_by'),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('tool_definitions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('tool_definitions_brand_name_key').on(t.tenantId, t.brandId, t.name),
    uniqueIndex('tool_definitions_remote_key')
      .on(t.tenantId, t.mcpServerId, t.remoteName)
      .where(sql`${t.mcpServerId} is not null`),
    foreignKey({
      name: 'tool_definitions_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'tool_definitions_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'tool_definitions_mcp_server_fk',
      columns: [t.tenantId, t.mcpServerId],
      foreignColumns: [mcpServers.tenantId, mcpServers.id],
    }),
    foreignKey({
      name: 'tool_definitions_reviewed_by_fk',
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'tool_definitions_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'tool_definitions_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'tool_definitions_source_ck',
      sql`(${t.source} = 'builtin' and ${t.builtin} is not null and ${t.mcpServerId} is null)
        or (${t.source} = 'mcp' and ${t.mcpServerId} is not null and ${t.remoteName} is not null)
        or (${t.source} = 'http' and ${t.builtin} is null and ${t.mcpServerId} is null)
        or (${t.source} = 'native' and ${t.builtin} is null and ${t.mcpServerId} is null and ${t.remoteName} is not null)`,
    ),
    // Money and irreversible actions: staff approve, never autopilot (also checked in code).
    check(
      'tool_definitions_high_risk_ck',
      sql`${t.risk} not in ('money', 'irreversible') or (${t.approver} = 'staff' and not ${t.autopilot})`,
    ),
    check(
      'tool_definitions_limits_ck',
      sql`${t.timeoutMs} between 1000 and 60000 and ${t.maxOutputBytes} between 256 and 262144 and ${t.revision} > 0`,
    ),
    tenantIsolation(),
  ],
);

/** Tenant-wide action settings: the autopilot switch and daily budget (G15). One row per tenant. */
export const actionSettings = pgTable(
  'action_settings',
  {
    id: id(),
    tenantId: tenantId(),
    autopilotEnabled: boolean('autopilot_enabled').notNull().default(true),
    dailyAutopilotLimit: integer('daily_autopilot_limit').notNull().default(200),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('action_settings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('action_settings_tenant_key').on(t.tenantId),
    foreignKey({
      name: 'action_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('action_settings_limit_ck', sql`${t.dailyAutopilotLimit} >= 0`),
    tenantIsolation(),
  ],
);

export const ACTION_STATES = [
  'awaiting_approval',
  'approved',
  'executing',
  'completed',
  'failed',
  'unknown',
  'declined',
  'expired',
  'superseded',
  'cancelled',
  'denied',
] as const;

/**
 * One action the AI proposed (G13, G14). The arguments, their hash, the tool revision, the
 * resource and its revision, the ownership epoch and the customer are fixed at the proposal (a
 * trigger refuses changes): an approval of this row is an approval of exactly these values.
 * `basis` says how it was allowed to run (autopilot, a person's approval) or that it was refused.
 */
export const actions = pgTable(
  'actions',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    runId: uuid('run_id'),
    agentId: uuid('agent_id'),
    agentVersionId: uuid('agent_version_id'),
    toolId: uuid('tool_id').notNull(),
    toolRevision: integer('tool_revision').notNull(),
    toolName: text('tool_name').notNull(),
    toolTitle: text('tool_title').notNull(),
    risk: text('risk', { enum: RISK_CLASSES }).notNull(),
    approver: text('approver', { enum: ACTION_APPROVERS }).notNull(),
    requiredPermission: text('required_permission'),
    /** Approving needs a fresh sign-in (staff) or identity check (customer). */
    stepUp: boolean('step_up').notNull().default(false),
    state: text('state', { enum: ACTION_STATES }).notNull(),
    basis: text('basis', { enum: ['autopilot', 'approval', 'refused'] }).notNull(),
    /** Why it waits, was refused or superseded (a code, never free text from outside). */
    reason: text('reason'),
    arguments: jsonb('arguments').$type<Record<string, unknown>>().notNull(),
    argumentsHash: bytea('arguments_hash').notNull(),
    summary: text('summary').notNull(),
    effects: jsonb('effects').$type<string[]>().notNull().default([]),
    changes: jsonb('changes')
      .$type<{ field: string; from: string | null; to: string }[]>()
      .notNull()
      .default([]),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    currency: text('currency'),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    resourceLabel: text('resource_label'),
    resourceRevision: text('resource_revision'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull(),
    principalId: uuid('principal_id'),
    /** Code for text approvals (W16 fallback). */
    code: text('code'),
    expiresAt: tstz('expires_at'),
    operationId: uuid('operation_id'),
    /**
     * What the result established, in words Hamnivo wrote from the tool's answer or receipt (for
     * handoff packets and staff); never the tool's own text.
     */
    outcomeSummary: text('outcome_summary'),
    decidedAt: tstz('decided_at'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('actions_tenant_id_id_key').on(t.tenantId, t.id),
    // The same call in the same run (a guard retry asks the model again) is the same action.
    uniqueIndex('actions_run_call_key')
      .on(t.tenantId, t.runId, t.toolId, t.argumentsHash)
      .where(sql`${t.runId} is not null`),
    index('actions_conversation_idx').on(t.tenantId, t.conversationId, t.createdAt),
    index('actions_open_idx')
      .on(t.tenantId, t.state)
      .where(sql`${t.state} in ('awaiting_approval', 'approved', 'executing', 'unknown')`),
    index('actions_autopilot_idx').on(t.tenantId, t.createdAt).where(sql`${t.basis} = 'autopilot'`),
    index('actions_expiry_idx').on(t.expiresAt).where(sql`${t.state} = 'awaiting_approval'`),
    foreignKey({
      name: 'actions_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'actions_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'actions_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'actions_agent_version_fk',
      columns: [t.tenantId, t.agentVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    foreignKey({
      name: 'actions_tool_fk',
      columns: [t.tenantId, t.toolId],
      foreignColumns: [toolDefinitions.tenantId, toolDefinitions.id],
    }),
    foreignKey({
      name: 'actions_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'actions_operation_fk',
      columns: [t.tenantId, t.operationId],
      foreignColumns: [operations.tenantId, operations.id],
    }),
    check('actions_hash_ck', sql`octet_length(${t.argumentsHash}) = 32`),
    check(
      'actions_high_risk_ck',
      sql`${t.risk} not in ('money', 'irreversible') or (${t.approver} = 'staff' and ${t.basis} <> 'autopilot')`,
    ),
    check('actions_amount_ck', sql`(${t.amountMinor} is null) = (${t.currency} is null)`),
    tenantIsolation(),
  ],
);

/**
 * Decisions people made on actions (G13): exactly what they saw (arguments hash, tool revision,
 * resource revision, ownership epoch), who, through which channel and with a fresh sign-in or
 * not. Append-only: the application role can insert but never change or delete a decision.
 */
export const actionApprovals = pgTable(
  'action_approvals',
  {
    id: id(),
    tenantId: tenantId(),
    actionId: uuid('action_id').notNull(),
    decision: text('decision', { enum: ['approved', 'declined'] }).notNull(),
    approverKind: text('approver_kind', { enum: ACTION_APPROVERS }).notNull(),
    /** `cus_…` or `stf_…`. */
    approverId: text('approver_id').notNull(),
    clientRequestId: uuid('client_request_id').notNull(),
    argumentsHash: bytea('arguments_hash').notNull(),
    toolRevision: integer('tool_revision').notNull(),
    resourceRevision: text('resource_revision'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull(),
    stepUp: boolean('step_up').notNull(),
    channel: text('channel', { enum: ['widget', 'inbox', 'text'] }).notNull(),
    /** Session, locale, origin; never secrets. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    reason: text('reason'),
    decidedAt: tstz('decided_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('action_approvals_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('action_approvals_action_key').on(t.tenantId, t.actionId),
    uniqueIndex('action_approvals_request_key').on(t.tenantId, t.clientRequestId),
    foreignKey({
      name: 'action_approvals_action_fk',
      columns: [t.tenantId, t.actionId],
      foreignColumns: [actions.tenantId, actions.id],
    }),
    check('action_approvals_hash_ck', sql`octet_length(${t.argumentsHash}) = 32`),
    tenantIsolation(),
  ],
);

/**
 * What the AI handed over to people (G10): one packet per handoff (conversation and ownership
 * epoch), built from Hamnivo's records. Append-only.
 */
export const handoffPackets = pgTable(
  'handoff_packets',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    runId: uuid('run_id'),
    reason: text('reason').notNull(),
    packet: jsonb('packet').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('handoff_packets_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('handoff_packets_epoch_key').on(t.tenantId, t.conversationId, t.epoch),
    foreignKey({
      name: 'handoff_packets_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'handoff_packets_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    tenantIsolation(),
  ],
);

/** Canned conversations with fake tool answers for an agent (G11). */
export const simulationSuites = pgTable(
  'simulation_suites',
  {
    id: id(),
    tenantId: tenantId(),
    agentId: uuid('agent_id').notNull(),
    name: text('name').notNull(),
    /** Publishing waits until the draft passes this suite. */
    required: boolean('required').notNull().default(false),
    cases: jsonb('cases').$type<Record<string, unknown>[]>().notNull(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('simulation_suites_tenant_id_id_key').on(t.tenantId, t.id),
    index('simulation_suites_agent_idx').on(t.tenantId, t.agentId),
    foreignKey({
      name: 'simulation_suites_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'simulation_suites_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'simulation_suites_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/** One replay of a suite: the draft against the published version, case by case (G11). */
export const simulationRuns = pgTable(
  'simulation_runs',
  {
    id: id(),
    tenantId: tenantId(),
    suiteId: uuid('suite_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    candidateVersionId: uuid('candidate_version_id').notNull(),
    baselineVersionId: uuid('baseline_version_id'),
    /** SHA-256 of the draft configuration that was replayed. */
    candidateConfigHash: bytea('candidate_config_hash').notNull(),
    status: text('status', { enum: ['passed', 'failed'] }).notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    results: jsonb('results').$type<Record<string, unknown>[]>().notNull(),
    startedAt: tstz('started_at').notNull(),
    finishedAt: tstz('finished_at').notNull(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    unique('simulation_runs_tenant_id_id_key').on(t.tenantId, t.id),
    index('simulation_runs_suite_idx').on(t.tenantId, t.suiteId, t.startedAt),
    index('simulation_runs_candidate_idx').on(t.tenantId, t.candidateVersionId),
    foreignKey({
      name: 'simulation_runs_suite_fk',
      columns: [t.tenantId, t.suiteId],
      foreignColumns: [simulationSuites.tenantId, simulationSuites.id],
    }),
    foreignKey({
      name: 'simulation_runs_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'simulation_runs_candidate_fk',
      columns: [t.tenantId, t.candidateVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    foreignKey({
      name: 'simulation_runs_baseline_fk',
      columns: [t.tenantId, t.baselineVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    foreignKey({
      name: 'simulation_runs_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);
