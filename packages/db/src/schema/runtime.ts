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
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { toolDefinitions } from './actions.js';
import { bytea, createdAt, id, platformRead, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { secrets, staffMembers } from './identity.js';
import { brands, tenantId, workspaces } from './tenancy.js';

export const MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;

/** A tenant's credentials for one model provider. The key lives in `secrets`, encrypted. */
export const modelConnections = pgTable(
  'model_connections',
  {
    id: id(),
    tenantId: tenantId(),
    provider: text('provider', { enum: MODEL_PROVIDERS }).notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url'),
    apiKeySecretId: uuid('api_key_secret_id').notNull(),
    /** Model IDs agents may use with these credentials; empty allows any. */
    allowedModels: text('allowed_models').array().notNull().default(sql`'{}'::text[]`),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('model_connections_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'model_connections_secret_fk',
      columns: [t.tenantId, t.apiKeySecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'model_connections_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
    // The platform console sees which providers are connected or switched off (never the key).
    platformRead(),
  ],
);

/** An AI agent of a brand. Its behaviour lives in versions; one of them is published. */
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    /** The brand's default agent answers the brand's conversations. */
    isDefault: boolean('is_default').notNull().default(false),
    publishedVersionId: uuid('published_version_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('agent_profiles_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('agent_profiles_brand_default_key')
      .on(t.tenantId, t.brandId)
      .where(sql`${t.isDefault} and ${t.status} = 'active'`),
    foreignKey({
      name: 'agent_profiles_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'agent_profiles_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'agent_profiles_published_version_fk',
      columns: [t.tenantId, t.publishedVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Agent configurations. A draft can change until it is published; after that the row is
 * immutable (enforced by a trigger), so a run can always say exactly what it ran with (A07).
 */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: id(),
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    version: integer('version').notNull(),
    state: text('state', { enum: ['draft', 'published', 'retired'] })
      .notNull()
      .default('draft'),
    config: jsonb('config').notNull(),
    /** SHA-256 of the canonical configuration, set on first publication. */
    configHash: bytea('config_hash'),
    createdBy: uuid('created_by'),
    publishedBy: uuid('published_by'),
    publishedAt: tstz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('agent_versions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('agent_versions_version_key').on(t.tenantId, t.profileId, t.version),
    uniqueIndex('agent_versions_one_draft_key')
      .on(t.tenantId, t.profileId)
      .where(sql`${t.state} = 'draft'`),
    uniqueIndex('agent_versions_one_published_key')
      .on(t.tenantId, t.profileId)
      .where(sql`${t.state} = 'published'`),
    foreignKey({
      name: 'agent_versions_profile_fk',
      columns: [t.tenantId, t.profileId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'agent_versions_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'agent_versions_published_by_fk',
      columns: [t.tenantId, t.publishedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('agent_versions_version_ck', sql`${t.version} > 0`),
    check(
      'agent_versions_published_ck',
      sql`${t.state} = 'draft' or (${t.configHash} is not null and ${t.publishedAt} is not null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Stops AI replies in a scope while people keep answering (X08). Active until cleared. A `tool`
 * switch stops one tool's actions only: replies go on, and calls to the tool are refused.
 */
export const killSwitches = pgTable(
  'kill_switches',
  {
    id: id(),
    tenantId: tenantId(),
    scope: text('scope', { enum: ['tenant', 'brand', 'agent', 'tool'] }).notNull(),
    brandId: uuid('brand_id'),
    agentId: uuid('agent_id'),
    toolId: uuid('tool_id'),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    clearedAt: tstz('cleared_at'),
    clearedBy: uuid('cleared_by'),
  },
  (t) => [
    unique('kill_switches_tenant_id_id_key').on(t.tenantId, t.id),
    index('kill_switches_active_idx').on(t.tenantId).where(sql`${t.clearedAt} is null`),
    check(
      'kill_switches_target_ck',
      sql`(${t.scope} = 'tenant' and ${t.brandId} is null and ${t.agentId} is null and ${t.toolId} is null)
        or (${t.scope} = 'brand' and ${t.brandId} is not null and ${t.agentId} is null and ${t.toolId} is null)
        or (${t.scope} = 'agent' and ${t.agentId} is not null and ${t.toolId} is null)
        or (${t.scope} = 'tool' and ${t.toolId} is not null and ${t.agentId} is null)`,
    ),
    foreignKey({
      name: 'kill_switches_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'kill_switches_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'kill_switches_tool_fk',
      columns: [t.tenantId, t.toolId],
      foreignColumns: [toolDefinitions.tenantId, toolDefinitions.id],
    }),
    foreignKey({
      name: 'kill_switches_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'kill_switches_cleared_by_fk',
      columns: [t.tenantId, t.clearedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
    // The platform console sees where AI replies are stopped (column grants leave out the reason).
    platformRead(),
  ],
);

export const RUN_OUTCOMES = [
  'replied',
  'drafted',
  'handoff',
  'fenced',
  'blocked',
  'error',
  'skipped',
  'cancelled',
] as const;

/**
 * One AI run: what triggered it, which agent version and model ran, and how it ended (G12).
 * It stores hashes and counts, never prompt or reply text (X11). A `guard` run is the message
 * guard reading a customer's message in a conversation the AI does not have; no model runs in it.
 */
export const runs = pgTable(
  'runs',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    brandId: uuid('brand_id'),
    agentId: uuid('agent_id'),
    agentVersionId: uuid('agent_version_id'),
    /** What started the run, unique per conversation, e.g. `reply:{ledgerId}`. */
    triggerRef: text('trigger_ref').notNull(),
    kind: text('kind', { enum: ['reply', 'draft', 'guard'] }).notNull(),
    state: text('state', { enum: ['running', 'succeeded', 'failed', 'skipped'] })
      .notNull()
      .default('running'),
    outcome: text('outcome', { enum: RUN_OUTCOMES }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    provider: text('provider'),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    errorKind: text('error_kind'),
    attempts: integer('attempts').notNull().default(1),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    /** A person asked to stop the run: its tool calls in flight are cancelled (G09, X08). */
    cancelRequestedAt: tstz('cancel_requested_at'),
    cancelRequestedBy: uuid('cancel_requested_by'),
  },
  (t) => [
    unique('runs_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'runs_cancel_requested_by_fk',
      columns: [t.tenantId, t.cancelRequestedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    uniqueIndex('runs_trigger_key').on(t.tenantId, t.conversationId, t.triggerRef),
    index('runs_conversation_idx').on(t.tenantId, t.conversationId, t.startedAt),
    index('runs_agent_idx').on(t.tenantId, t.agentId, t.startedAt),
    foreignKey({
      name: 'runs_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'runs_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'runs_agent_version_fk',
      columns: [t.tenantId, t.agentVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    tenantIsolation(),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    tenantId: tenantId(),
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['model', 'guard', 'decision', 'retrieval', 'tool'] }).notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['ok', 'error', 'blocked', 'skipped'] }).notNull(),
    provider: text('provider'),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    inputHash: bytea('input_hash'),
    outputHash: bytea('output_hash'),
    /** Non-sensitive facts only: finish reason, error kind, which rule matched. */
    detail: jsonb('detail').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'run_steps_pkey', columns: [t.tenantId, t.runId, t.seq] }),
    foreignKey({
      name: 'run_steps_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    tenantIsolation(),
  ],
);
