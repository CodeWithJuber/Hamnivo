import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals } from './identity.js';
import { EMBEDDING_DIMENSIONS } from './knowledge.js';
import { brands, tenantId, workspaces } from './tenancy.js';

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

export const CONSENT_SCOPES = [
  /** Remember this customer's preferences for later chats (L04). */
  'personal_memory',
  /** Use their conversations to improve this business's assistant (L08). */
  'tenant_improvement',
  /** Contribute to improvements shared across businesses (L08). */
  'global_contribution',
  /** Use their data to train models (L08, L16). */
  'model_training',
] as const;

/**
 * Consent decisions, one row per decision (append-only: the application can neither change nor
 * delete them). The latest row per customer and scope is the current choice. Personal memory is
 * one scope; learning and training are separate scopes and are never bundled with it. A decision
 * outlives the customer when retention removes them (A10), so it has no foreign key to them.
 */
export const learningConsents = pgTable(
  'learning_consents',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    scope: text('scope', { enum: CONSENT_SCOPES }).notNull(),
    state: text('state', { enum: ['granted', 'declined', 'withdrawn'] }).notNull(),
    /** The explanation the customer saw. */
    noticeVersion: text('notice_version').notNull(),
    actorType: text('actor_type', { enum: ['customer', 'staff'] }).notNull(),
    actorId: text('actor_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('learning_consents_tenant_id_id_key').on(t.tenantId, t.id),
    index('learning_consents_subject_idx').on(t.tenantId, t.subjectId, t.scope, t.createdAt),
    foreignKey({
      name: 'learning_consents_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check(
      'learning_consents_scope_ck',
      sql`${t.scope} in ('personal_memory', 'tenant_improvement', 'global_contribution', 'model_training')`,
    ),
    check('learning_consents_state_ck', sql`${t.state} in ('granted', 'declined', 'withdrawn')`),
    tenantIsolation(),
  ],
);

export const MEMORY_RECORD_STATUSES = ['active', 'pending', 'superseded', 'outdated'] as const;

/**
 * Customer memory records: the blueprint §22 envelope (L01, L02). A record's content never
 * changes after it is written; a correction is a new record that supersedes it (L03), enforced
 * by a trigger. Only the lifecycle columns change. Deleting a record leaves a tombstone.
 */
export const memoryRecords = pgTable(
  'memory_records',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    /** The customer principal the record is about. */
    subjectId: uuid('subject_id').notNull(),
    conversationId: uuid('conversation_id'),
    scope: text('scope', {
      enum: ['session', 'conversation', 'person', 'team', 'tenant'],
    }).notNull(),
    kind: text('kind', {
      enum: [
        'observation',
        'episode',
        'claim',
        'preference',
        'procedure',
        'commitment',
        'constraint',
        'outcome',
        'correction',
      ],
    }).notNull(),
    /** The slot, such as `preferred_language`. */
    key: text('key').notNull(),
    /** `{ value }`: what is remembered. */
    payload: jsonb('payload').$type<{ value: string }>().notNull(),
    /** SHA-256 of the canonical kind, slot and value. */
    contentHash: bytea('content_hash').notNull(),
    sourceType: text('source_type', {
      enum: [
        'customer_statement',
        'customer_control',
        'staff_entry',
        'agent_inference',
        'system_record',
        'import',
      ],
    }).notNull(),
    /** The messages or events the record came from (public ids). */
    sourceEventIds: text('source_event_ids').array().notNull().default(sql`'{}'::text[]`),
    evidenceStatus: text('evidence_status', {
      enum: ['supported', 'refuted', 'conflicting', 'unknown'],
    }).notNull(),
    writtenByType: text('written_by_type', {
      enum: ['customer', 'staff', 'ai', 'system'],
    }).notNull(),
    writtenById: text('written_by_id'),
    writeReason: text('write_reason').notNull(),
    /** Free text from staff about a change; deleted with the record. */
    writeNote: text('write_note'),
    purpose: text('purpose').notNull(),
    allowedPurposes: text('allowed_purposes').array().notNull(),
    allowedRoles: text('allowed_roles').array().notNull(),
    /** Envelope fields for grant- and ACL-bound memory (not used by customer memory yet). */
    accessGrantId: uuid('access_grant_id'),
    subjectAclRef: text('subject_acl_ref'),
    sensitivity: text('sensitivity', { enum: ['normal', 'personal'] }).notNull(),
    retentionClass: text('retention_class', { enum: ['short', 'medium', 'long'] }).notNull(),
    expiresAt: tstz('expires_at'),
    policyVersion: text('policy_version').notNull(),
    status: text('status', { enum: MEMORY_RECORD_STATUSES }).notNull(),
    reviewStatus: text('review_status', { enum: ['auto', 'confirmed', 'pending'] }).notNull(),
    /** Who confirmed or reviewed it (`customer:cus_…`, `staff:stf_…`). */
    reviewedBy: text('reviewed_by'),
    reviewedAt: tstz('reviewed_at'),
    confidence: jsonb('confidence').notNull().default({}),
    version: integer('version').notNull().default(1),
    // History links are not foreign keys: older versions may reach their retention first.
    supersedesId: uuid('supersedes_id'),
    supersededById: uuid('superseded_by_id'),
    /** Event time. */
    observedAt: tstz('observed_at').notNull(),
    validFrom: tstz('valid_from').notNull(),
    validUntil: tstz('valid_until'),
    /** Transaction time. */
    recordedAt: tstz('recorded_at').notNull().defaultNow(),
    supersededAt: tstz('superseded_at'),
    lastConfirmedAt: tstz('last_confirmed_at'),
    updatedAt: updatedAt(),
    // 'simple' does no stemming, so every language indexes word by word.
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', replace("key", '_', ' ') || ' ' || coalesce("payload"->>'value', ''))`,
    ),
  },
  (t) => [
    unique('memory_records_tenant_id_id_key').on(t.tenantId, t.id),
    // Corrections supersede: two values of one slot are never current together.
    uniqueIndex('memory_records_one_active_person_key')
      .on(t.tenantId, t.subjectId, t.key)
      .where(sql`${t.status} = 'active' and ${t.scope} = 'person'`),
    uniqueIndex('memory_records_one_active_conversation_key')
      .on(t.tenantId, t.subjectId, t.key, t.conversationId)
      .where(sql`${t.status} = 'active' and ${t.scope} = 'conversation'`),
    uniqueIndex('memory_records_one_pending_key')
      .on(t.tenantId, t.subjectId, t.key)
      .where(sql`${t.status} = 'pending'`),
    index('memory_records_subject_idx').on(t.tenantId, t.subjectId, t.status),
    index('memory_records_brand_idx').on(t.tenantId, t.brandId),
    index('memory_records_expiry_idx').on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
    index('memory_records_search_idx').using('gin', t.search),
    foreignKey({
      name: 'memory_records_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'memory_records_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'memory_records_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check(
      'memory_records_status_ck',
      sql`${t.status} in ('active', 'pending', 'superseded', 'outdated')`,
    ),
    check(
      'memory_records_kind_ck',
      sql`${t.kind} in ('observation', 'episode', 'claim', 'preference', 'procedure', 'commitment', 'constraint', 'outcome', 'correction')`,
    ),
    check(
      'memory_records_scope_ck',
      sql`${t.scope} in ('session', 'conversation', 'person', 'team', 'tenant')`,
    ),
    check('memory_records_sensitivity_ck', sql`${t.sensitivity} in ('normal', 'personal')`),
    check(
      'memory_records_validity_ck',
      sql`${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`,
    ),
    check('memory_records_version_ck', sql`${t.version} > 0`),
    tenantIsolation(),
  ],
);

/**
 * Vectors of memory records for recall (G19), like knowledge chunks: a projection that can be
 * rebuilt, bound to the model and the content hash it was computed from. Deleted with the record.
 */
export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    id: id(),
    tenantId: tenantId(),
    memoryId: uuid('memory_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    contentHash: bytea('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('memory_embeddings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('memory_embeddings_model_key').on(t.tenantId, t.memoryId, t.embeddingModel),
    index('memory_embeddings_subject_idx').on(t.tenantId, t.subjectId),
    index('memory_embeddings_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    foreignKey({
      name: 'memory_embeddings_memory_fk',
      columns: [t.tenantId, t.memoryId],
      foreignColumns: [memoryRecords.tenantId, memoryRecords.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

/**
 * Deletion receipts (L05, HNV-15-05): what was deleted, by whom and why, and whether every index
 * and cache has been purged. `completed` is set only after the worker verified it. Kept without
 * content; the subject id outlives the customer on purpose.
 */
export const memoryDeletions = pgTable(
  'memory_deletions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    scope: text('scope', { enum: ['record', 'customer'] }).notNull(),
    reason: text('reason', {
      enum: [
        'customer_request',
        'staff_request',
        'erasure_request',
        'retention_expired',
        'review_rejected',
      ],
    }).notNull(),
    requestedByType: text('requested_by_type', {
      enum: ['customer', 'staff', 'system'],
    }).notNull(),
    requestedById: text('requested_by_id'),
    recordCount: integer('record_count').notNull(),
    status: text('status', { enum: ['pending', 'completed'] })
      .notNull()
      .default('pending'),
    /** Per step: `done` or `pending`. */
    steps: jsonb('steps').$type<Record<string, 'done' | 'pending'>>().notNull(),
    createdAt: createdAt(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    unique('memory_deletions_tenant_id_id_key').on(t.tenantId, t.id),
    index('memory_deletions_subject_idx').on(t.tenantId, t.subjectId, t.createdAt),
    foreignKey({
      name: 'memory_deletions_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check('memory_deletions_status_ck', sql`${t.status} in ('pending', 'completed')`),
    tenantIsolation(),
  ],
);

/**
 * Deletion tombstones (L05, K09): the slot, source ids and keyed value fingerprints of what was
 * deleted, never its content. Replays and retried jobs consult them before writing, a trigger
 * refuses to insert a tombstoned record again, and restores replay them (app.apply_memory_
 * tombstones) before memory becomes usable. Append-only for the application.
 */
export const deletionTombstones = pgTable(
  'deletion_tombstones',
  {
    id: id(),
    tenantId: tenantId(),
    deletionId: uuid('deletion_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** `memory_record`: one record. `memory_subject`: everything about the customer. */
    targetType: text('target_type', { enum: ['memory_record', 'memory_subject'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    memoryKey: text('memory_key'),
    sourceEventIds: text('source_event_ids').array().notNull().default(sql`'{}'::text[]`),
    /** HMAC fingerprints of the deleted value (`<key version>:<hex>`). */
    fingerprints: text('fingerprints').array().notNull().default(sql`'{}'::text[]`),
    /** When the deleted evidence was observed; for an erasure, the erasure time. */
    observedAt: tstz('observed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('deletion_tombstones_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('deletion_tombstones_record_key')
      .on(t.tenantId, t.targetId)
      .where(sql`${t.targetType} = 'memory_record'`),
    index('deletion_tombstones_subject_idx').on(t.tenantId, t.subjectId),
    foreignKey({
      name: 'deletion_tombstones_deletion_fk',
      columns: [t.tenantId, t.deletionId],
      foreignColumns: [memoryDeletions.tenantId, memoryDeletions.id],
    }),
    tenantIsolation(),
  ],
);
