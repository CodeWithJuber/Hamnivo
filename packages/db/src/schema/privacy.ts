import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * A workspace's retention policy (A10): resolved conversations whose last activity is older than
 * `conversation_days` are deleted in the chat engine and in Hamnivo, and customers left with none
 * are removed. Null keeps everything, which is where every workspace starts. Turning retention on
 * or shortening it waits in `pending_days` until `pending_from`, so a mistake can be undone before
 * anything is deleted; the worker's sweep applies it then. The periods allowed are the contract's
 * RETENTION_DAYS.
 */
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: id(),
    tenantId: tenantId(),
    conversationDays: integer('conversation_days'),
    pendingDays: integer('pending_days'),
    pendingFrom: tstz('pending_from'),
    /**
     * The last sweep: `blocked` when the chat engine refused to delete (its user is not an
     * administrator), in which case nothing was deleted in Hamnivo either.
     */
    sweepState: text('sweep_state', { enum: ['idle', 'running', 'blocked'] })
      .notNull()
      .default('idle'),
    sweptAt: tstz('swept_at'),
    /** Conversations and customers deleted so far, for Studio's progress. */
    conversationsDeleted: bigint('conversations_deleted', { mode: 'number' }).notNull().default(0),
    customersDeleted: bigint('customers_deleted', { mode: 'number' }).notNull().default(0),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('retention_policies_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('retention_policies_tenant_key').on(t.tenantId),
    foreignKey({
      name: 'retention_policies_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'retention_policies_days_ck',
      sql`(${t.conversationDays} is null or ${t.conversationDays} in (90, 180, 365, 730, 1095, 1825, 2555))
        and (${t.pendingDays} is null or ${t.pendingDays} in (90, 180, 365, 730, 1095, 1825, 2555))`,
    ),
    check(
      'retention_policies_pending_ck',
      sql`(${t.pendingDays} is null) = (${t.pendingFrom} is null)`,
    ),
    check(
      'retention_policies_counts_ck',
      sql`${t.conversationsDeleted} >= 0 and ${t.customersDeleted} >= 0`,
    ),
    tenantIsolation(),
  ],
);

export const PRIVACY_REQUEST_KINDS = ['export', 'erase'] as const;
export const PRIVACY_REQUEST_STATES = [
  'queued',
  'running',
  'completed',
  'blocked',
  'failed',
] as const;
export const PRIVACY_REQUEST_REASONS = ['access_request', 'erasure_request', 'other'] as const;

/** Chatwoot items an erasure covered, by connection: what a restore may bring back. */
export interface ErasedAuthorityItems {
  contacts: { connectionId: string; id: number }[];
  conversations: { connectionId: string; id: number }[];
}

/**
 * A request to export or erase one customer's data (A10), and its receipt. Requests are kept:
 * an erasure's receipt is the proof that it happened, and it outlives the customer, so
 * `principal_id` has no foreign key. Counts say what was exported or deleted, never content.
 */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind', { enum: PRIVACY_REQUEST_KINDS }).notNull(),
    brandId: uuid('brand_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    state: text('state', { enum: PRIVACY_REQUEST_STATES }).notNull().default('queued'),
    reason: text('reason', { enum: PRIVACY_REQUEST_REASONS }).notNull(),
    /** The business's own reference for the request, such as a ticket number. */
    reference: text('reference'),
    requestedBy: uuid('requested_by'),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    /** Why it stopped, e.g. `authority_not_admin`, `too_large`. */
    problem: text('problem'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    unique('privacy_requests_tenant_id_id_key').on(t.tenantId, t.id),
    index('privacy_requests_created_idx').on(t.tenantId, t.createdAt),
    index('privacy_requests_principal_idx').on(t.tenantId, t.principalId),
    foreignKey({
      name: 'privacy_requests_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'privacy_requests_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'privacy_requests_reference_ck',
      sql`${t.reference} is null or char_length(${t.reference}) between 1 and 80`,
    ),
    check('privacy_requests_attempts_ck', sql`${t.attempts} >= 0`),
    tenantIsolation(),
  ],
);

/**
 * The file an export produced: a ZIP kept 24 hours, then its bytes are cleared by the worker's
 * maintenance (the row stays, so a late download is answered with "gone").
 */
export const privacyFiles = pgTable(
  'privacy_files',
  {
    id: id(),
    tenantId: tenantId(),
    requestId: uuid('request_id').notNull(),
    raw: bytea('raw'),
    sha256: text('sha256').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    purgeAfter: tstz('purge_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('privacy_files_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('privacy_files_request_key').on(t.tenantId, t.requestId),
    foreignKey({
      name: 'privacy_files_request_fk',
      columns: [t.tenantId, t.requestId],
      foreignColumns: [privacyRequests.tenantId, privacyRequests.id],
    }),
    check('privacy_files_size_ck', sql`${t.byteSize} >= 0`),
    tenantIsolation(),
  ],
);

/**
 * What an erasure removed, so it stays removed (A10): a restore that brings the customer back is
 * replayed from here, and a later import skips them. Append-only. It holds no personal data: the
 * customer's id, the chat engine's ids, and keyed fingerprints (HMACs) of what identified them,
 * which recognise the same person again without saying who they were.
 */
export const erasureTombstones = pgTable(
  'erasure_tombstones',
  {
    id: id(),
    tenantId: tenantId(),
    requestId: uuid('request_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    authority: jsonb('authority')
      .$type<ErasedAuthorityItems>()
      .notNull()
      .default({ contacts: [], conversations: [] }),
    fingerprints: text('fingerprints').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('erasure_tombstones_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('erasure_tombstones_request_key').on(t.tenantId, t.requestId),
    index('erasure_tombstones_principal_idx').on(t.tenantId, t.principalId),
    index('erasure_tombstones_fingerprints_idx').using('gin', t.fingerprints),
    foreignKey({
      name: 'erasure_tombstones_request_fk',
      columns: [t.tenantId, t.requestId],
      foreignColumns: [privacyRequests.tenantId, privacyRequests.id],
    }),
    tenantIsolation(),
  ],
);
