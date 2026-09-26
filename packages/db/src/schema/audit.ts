import { bigint, index, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { tenantId, tenants } from './tenancy.js';

export const AUDIT_ACTOR_TYPES = [
  'staff',
  'service_account',
  'customer',
  'ai',
  'system',
  'platform',
] as const;
export const AUDIT_OUTCOMES = ['success', 'denied', 'failed'] as const;

/** Head of each tenant's audit hash chain; locked while an event is appended. */
export const auditHeads = pgTable(
  'audit_heads',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastHash: bytea('last_hash').notNull(),
    updatedAt: updatedAt(),
  },
  () => [tenantIsolation()],
);

/**
 * Append-only, hash-chained audit log (A09), range-partitioned by month in SQL. The application
 * role may insert and read its tenant's events but never update or delete them.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    tenantId: tenantId(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    id: uuid('id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    reason: text('reason'),
    requestId: text('request_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    primaryKey({ name: 'audit_events_pkey', columns: [t.tenantId, t.seq, t.occurredAt] }),
    index('audit_events_time_idx').on(t.tenantId, t.occurredAt),
    index('audit_events_target_idx').on(t.tenantId, t.targetType, t.targetId),
    tenantIsolation(),
  ],
);
