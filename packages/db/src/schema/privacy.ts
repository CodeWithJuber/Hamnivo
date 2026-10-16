import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { tenantId } from './tenancy.js';

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
