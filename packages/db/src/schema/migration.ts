import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authorityConnections, authorityInboxes } from './authority.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { secrets, staffMembers } from './identity.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/**
 * Migration (M01–M08). Hamnivo keeps the state of each import, never the transcripts: imported
 * conversations live in Chatwoot. The uploaded export stays in quarantine only while its job needs
 * it, and is purged afterwards.
 */

export const MIGRATION_SOURCES = ['tawk.to', 'hamnivo', 'chatwoot', 'intercom', 'zendesk'] as const;

export const MIGRATION_JOB_STATES = [
  'scanning',
  'rejected',
  'blocked',
  'ready',
  'dry_running',
  'dry_run_ready',
  'queued',
  'running',
  'paused',
  'cancelled',
  'completed',
  'failed',
  'rolling_back',
  'rolled_back',
  'closed',
] as const;
export type MigrationJobState = (typeof MIGRATION_JOB_STATES)[number];

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

/** One import (or export) run: its source, its state and a checkpoint to resume from. */
export const migrationJobs = pgTable(
  'migration_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    /** The brand's Chatwoot connection, and the import inbox created for it. */
    connectionId: uuid('connection_id'),
    importInboxId: uuid('import_inbox_id'),
    sourceSystem: text('source_system', { enum: MIGRATION_SOURCES }).notNull(),
    sourceKind: text('source_kind', { enum: ['file', 'api'] }).notNull(),
    /** Upload name or source label, shown in Studio. */
    label: text('label').notNull(),
    state: text('state', { enum: MIGRATION_JOB_STATES }).notNull().default('scanning'),
    /** A staff request the worker applies at its next checkpoint. */
    requestedAction: text('requested_action', { enum: ['pause', 'cancel'] }),
    options: jsonb('options').notNull().default({}),
    /** Preflight report: counts, fields, limits and checks. No message content. */
    preflight: jsonb('preflight'),
    dryRun: jsonb('dry_run'),
    checkpoint: jsonb('checkpoint').notNull().default({}),
    stats: jsonb('stats').notNull().default({}),
    /** API sources: where to read from; the credential itself is in `secrets`. */
    sourceConfig: jsonb('source_config').notNull().default({}),
    sourceSecretId: uuid('source_secret_id'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    attempts: integer('attempts').notNull().default(0),
    /** One worker at a time runs a job. */
    leaseUntil: tstz('lease_until'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    closedAt: tstz('closed_at'),
  },
  (t) => [
    unique('migration_jobs_tenant_id_id_key').on(t.tenantId, t.id),
    index('migration_jobs_brand_idx').on(t.tenantId, t.brandId, t.createdAt),
    foreignKey({
      name: 'migration_jobs_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'migration_jobs_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'migration_jobs_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'migration_jobs_import_inbox_fk',
      columns: [t.tenantId, t.importInboxId],
      foreignColumns: [authorityInboxes.tenantId, authorityInboxes.id],
    }),
    foreignKey({
      name: 'migration_jobs_source_secret_fk',
      columns: [t.tenantId, t.sourceSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'migration_jobs_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('migration_jobs_state_ck', sql`${t.state} in (${inList(MIGRATION_JOB_STATES)})`),
    tenantIsolation(),
  ],
);

/**
 * Uploaded exports (and generated packages) in quarantine: scanned before use, and `raw` cleared
 * when the job no longer needs the file.
 */
export const migrationFiles = pgTable(
  'migration_files',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    purpose: text('purpose', { enum: ['export', 'package'] }).notNull(),
    name: text('name').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: bytea('sha256').notNull(),
    state: text('state', { enum: ['quarantined', 'clean', 'rejected', 'purged'] })
      .notNull()
      .default('quarantined'),
    raw: bytea('raw'),
    scanEngine: text('scan_engine'),
    rejectedReason: text('rejected_reason'),
    purgeAfter: tstz('purge_after'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    scannedAt: tstz('scanned_at'),
    purgedAt: tstz('purged_at'),
  },
  (t) => [
    unique('migration_files_tenant_id_id_key').on(t.tenantId, t.id),
    index('migration_files_job_idx').on(t.tenantId, t.jobId),
    index('migration_files_purge_idx')
      .on(t.purgeAfter)
      .where(sql`${t.raw} is not null`),
    foreignKey({
      name: 'migration_files_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [migrationJobs.tenantId, migrationJobs.id],
    }),
    foreignKey({
      name: 'migration_files_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const MIGRATION_ITEM_KINDS = ['contact', 'conversation', 'message', 'attachment'] as const;
export const MIGRATION_ITEM_STATUSES = [
  'pending',
  'writing',
  'imported',
  'skipped',
  'quarantined',
  'failed',
  'rolled_back',
] as const;

/**
 * One object of an export: its source ID, what became of it and where it went. `writing` is set
 * before a write is sent, so a crash leaves a record of the write that may have happened.
 */
export const migrationItems = pgTable(
  'migration_items',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    kind: text('kind', { enum: MIGRATION_ITEM_KINDS }).notNull(),
    sourceId: text('source_id').notNull(),
    conversationSourceId: text('conversation_source_id'),
    seq: integer('seq').notNull().default(0),
    status: text('status', { enum: MIGRATION_ITEM_STATUSES }).notNull().default('pending'),
    reason: text('reason'),
    /** Safe summary of a failure (codes and statuses only, never content). */
    detail: text('detail'),
    /** Internal notes, which must stay private. */
    private: boolean('private').notNull().default(false),
    /** The object in Chatwoot (contact, conversation display or message ID). */
    targetRef: text('target_ref'),
    /** This job created the target (only such targets are removed by a rollback). */
    created: boolean('created').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    importedAt: tstz('imported_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('migration_items_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('migration_items_source_key').on(t.tenantId, t.jobId, t.kind, t.sourceId),
    index('migration_items_status_idx').on(t.tenantId, t.jobId, t.status),
    index('migration_items_conversation_idx').on(
      t.tenantId,
      t.jobId,
      t.conversationSourceId,
      t.kind,
      t.seq,
    ),
    foreignKey({
      name: 'migration_items_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [migrationJobs.tenantId, migrationJobs.id],
    }),
    check('migration_items_status_ck', sql`${t.status} in (${inList(MIGRATION_ITEM_STATUSES)})`),
    check('migration_items_kind_ck', sql`${t.kind} in (${inList(MIGRATION_ITEM_KINDS)})`),
    tenantIsolation(),
  ],
);

/**
 * Source ID → Chatwoot object, unique per connection and source system: a conversation imported
 * once is recognised by later imports (they skip it) until a rollback removes the mapping.
 */
export const externalIdMappings = pgTable(
  'external_id_mappings',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    sourceSystem: text('source_system', { enum: MIGRATION_SOURCES }).notNull(),
    kind: text('kind', { enum: ['contact', 'conversation'] }).notNull(),
    sourceId: text('source_id').notNull(),
    targetRef: text('target_ref').notNull(),
    jobId: uuid('job_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('external_id_mappings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('external_id_mappings_source_key').on(
      t.tenantId,
      t.connectionId,
      t.sourceSystem,
      t.kind,
      t.sourceId,
    ),
    index('external_id_mappings_job_idx').on(t.tenantId, t.jobId),
    foreignKey({
      name: 'external_id_mappings_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'external_id_mappings_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'external_id_mappings_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [migrationJobs.tenantId, migrationJobs.id],
    }),
    tenantIsolation(),
  ],
);

/** Reconciliation and rollback reports (M08): counts and checks, never content. */
export const reconciliationReports = pgTable(
  'reconciliation_reports',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    kind: text('kind', { enum: ['reconciliation', 'rollback'] }).notNull(),
    gate: text('gate', { enum: ['passed', 'failed'] }).notNull(),
    report: jsonb('report').notNull(),
    /** Cutover approval; approving a failed gate needs an explicit acknowledgement. */
    approvedBy: uuid('approved_by'),
    approvedAt: tstz('approved_at'),
    acknowledged: boolean('acknowledged').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('reconciliation_reports_tenant_id_id_key').on(t.tenantId, t.id),
    index('reconciliation_reports_job_idx').on(t.tenantId, t.jobId, t.createdAt),
    foreignKey({
      name: 'reconciliation_reports_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [migrationJobs.tenantId, migrationJobs.id],
    }),
    foreignKey({
      name: 'reconciliation_reports_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);
