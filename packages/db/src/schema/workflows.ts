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
import { actions } from './actions.js';
import { conversationControls } from './authority.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { secrets } from './identity.js';
import { agentProfiles, agentVersions, runs } from './runtime.js';
import { brands, tenantId } from './tenancy.js';

export const workflows = pgTable(
  'workflows',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    publishedVersionId: uuid('published_version_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'workflows_published_version_fk',
      columns: [t.tenantId, t.id, t.publishedVersionId],
      foreignColumns: [workflowVersions.tenantId, workflowVersions.workflowId, workflowVersions.id],
    }),
    check('workflows_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    unique('workflows_tenant_id_id_key').on(t.tenantId, t.id),
    unique('workflows_brand_id_id_key').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      name: 'workflows_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check('workflows_revision_ck', sql`${t.revision}>0`),
    tenantIsolation(),
  ],
);
export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: id(),
    tenantId: tenantId(),
    workflowId: uuid('workflow_id').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    publishedAt: tstz('published_at').notNull().defaultNow(),
  },
  (t) => [
    unique('workflow_versions_tenant_id_id_key').on(t.tenantId, t.id),
    unique('workflow_versions_workflow_id_id_key').on(t.tenantId, t.workflowId, t.id),
    uniqueIndex('workflow_versions_number_key').on(t.tenantId, t.workflowId, t.version),
    foreignKey({
      name: 'workflow_versions_workflow_fk',
      columns: [t.tenantId, t.workflowId],
      foreignColumns: [workflows.tenantId, workflows.id],
    }),
    check('workflow_versions_number_ck', sql`${t.version}>0`),
    tenantIsolation(),
  ],
);
export const a2aConnections = pgTable(
  'a2a_connections',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    endpoint: text('endpoint').notNull(),
    credentialSecretId: uuid('credential_secret_id'),
    enabled: boolean('enabled').notNull().default(true),
    timeoutSeconds: integer('timeout_seconds').notNull().default(15),
    protocolVersion: text('protocol_version').notNull().default('1.0'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('a2a_connections_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'a2a_connections_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'a2a_connections_secret_fk',
      columns: [t.tenantId, t.credentialSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    check('a2a_connections_timeout_ck', sql`${t.timeoutSeconds} between 1 and 30`),
    check('a2a_connections_protocol_ck', sql`${t.protocolVersion}='1.0'`),
    tenantIsolation(),
  ],
);
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    versionId: uuid('version_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    runtimeRunId: uuid('runtime_run_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    agentVersionId: uuid('agent_version_id').notNull(),
    eventKey: text('event_key').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    state: text('state', {
      enum: [
        'queued',
        'running',
        'waiting',
        'awaiting_approval',
        'completed',
        'cancelled',
        'handed_off',
        'failed',
      ],
    })
      .notNull()
      .default('queued'),
    currentStepId: text('current_step_id'),
    reason: text('reason'),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull().default({}),
    stepsUsed: integer('steps_used').notNull().default(0),
    delegationsUsed: integer('delegations_used').notNull().default(0),
    untrustedContext: boolean('untrusted_context').notNull().default(false),
    wakeAt: tstz('wake_at'),
    deadline: tstz('deadline').notNull(),
    leaseToken: uuid('lease_token'),
    leaseUntil: tstz('lease_until'),
    cancelRequestedAt: tstz('cancel_requested_at'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    unique('workflow_runs_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('workflow_runs_event_key').on(
      t.tenantId,
      t.workflowId,
      t.conversationId,
      t.eventKey,
    ),
    index('workflow_runs_due_idx').on(t.tenantId, t.state, t.wakeAt),
    foreignKey({
      name: 'workflow_runs_workflow_fk',
      columns: [t.tenantId, t.brandId, t.workflowId],
      foreignColumns: [workflows.tenantId, workflows.brandId, workflows.id],
    }),
    foreignKey({
      name: 'workflow_runs_version_fk',
      columns: [t.tenantId, t.workflowId, t.versionId],
      foreignColumns: [workflowVersions.tenantId, workflowVersions.workflowId, workflowVersions.id],
    }),
    foreignKey({
      name: 'workflow_runs_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'workflow_runs_runtime_fk',
      columns: [t.tenantId, t.runtimeRunId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'workflow_runs_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'workflow_runs_agent_version_fk',
      columns: [t.tenantId, t.agentVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    check(
      'workflow_runs_state_ck',
      sql`${t.state} in ('queued','running','waiting','awaiting_approval','completed','cancelled','handed_off','failed')`,
    ),
    check(
      'workflow_runs_counters_ck',
      sql`${t.stepsUsed} between 0 and 100 and ${t.delegationsUsed} between 0 and 8`,
    ),
    tenantIsolation(),
  ],
);
export const workflowRunSteps = pgTable(
  'workflow_run_steps',
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid('run_id').notNull(),
    stepId: text('step_id').notNull(),
    type: text('type').notNull(),
    state: text('state', {
      enum: ['running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'unknown'],
    }).notNull(),
    actionId: uuid('action_id'),
    summary: text('summary'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    foreignKey({
      name: 'workflow_run_steps_action_fk',
      columns: [t.tenantId, t.actionId],
      foreignColumns: [actions.tenantId, actions.id],
    }),
    check(
      'workflow_run_steps_state_ck',
      sql`${t.state} in ('running','waiting','awaiting_approval','completed','failed','unknown')`,
    ),
    uniqueIndex('workflow_run_steps_once_key').on(t.tenantId, t.runId, t.stepId),
    foreignKey({
      name: 'workflow_run_steps_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
    }),
    tenantIsolation(),
  ],
);
