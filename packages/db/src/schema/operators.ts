import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AUDIT_OUTCOMES } from './audit.js';
import { bytea, citext, createdAt, id, platformRole, tstz, updatedAt } from './helpers.js';
import { tenants } from './tenancy.js';

/**
 * Platform operations (A17). These tables are global, not tenant data, so they carry no tenant_id
 * and are on the RLS suite's explicit allowlist. The application role has no access at all; the
 * platform console works through the hamnivo_platform role, and only the database owner (the
 * server administrator) names operators.
 */

const ownerRole = pgRole('hamnivo_owner').existing();

export const PLATFORM_OPERATOR_ROLES = [
  'platform_admin',
  'support_operator',
  'platform_viewer',
] as const;

/** A Hamnivo staff member who may use the platform console, and in which role. */
export const platformOperators = pgTable(
  'platform_operators',
  {
    id: id(),
    /** Better Auth user id; the operator signs in like anyone else. */
    authUserId: text('auth_user_id').notNull(),
    displayName: text('display_name').notNull(),
    email: citext('email').notNull(),
    role: text('role', { enum: PLATFORM_OPERATOR_ROLES }).notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_operators_auth_user_key').on(t.authUserId),
    pgPolicy('platform_read', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
    pgPolicy('owner_manage', {
      as: 'permissive',
      for: 'all',
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/** Head of the platform audit hash chain (one row), locked while an event is appended. */
export const platformAuditHead = pgTable(
  'platform_audit_head',
  {
    id: smallint('id').primaryKey().default(1),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastHash: bytea('last_hash').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_audit_head_single_ck', sql`${t.id} = 1`),
    pgPolicy('platform_chain', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    // The server administrator's operator changes are recorded in the same chain.
    pgPolicy('owner_chain', {
      as: 'permissive',
      for: 'all',
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/**
 * What platform operators did, append-only and hash-chained like the tenant audit log. A support
 * session is recorded here and in the tenant's own audit log (A18).
 */
export const platformAuditEvents = pgTable(
  'platform_audit_events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    operatorId: uuid('operator_id').references(() => platformOperators.id),
    action: text('action').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
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
    index('platform_audit_events_time_idx').on(t.occurredAt),
    index('platform_audit_events_tenant_idx').on(t.tenantId, t.occurredAt),
    pgPolicy('platform_read', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
    pgPolicy('platform_append', {
      as: 'permissive',
      for: 'insert',
      to: platformRole,
      withCheck: sql`true`,
    }),
    pgPolicy('owner_read', { as: 'permissive', for: 'select', to: ownerRole, using: sql`true` }),
    pgPolicy('owner_append', {
      as: 'permissive',
      for: 'insert',
      to: ownerRole,
      withCheck: sql`true`,
    }),
  ],
);

export const INCIDENT_SEVERITIES = ['notice', 'degraded', 'outage'] as const;

/** A platform incident; while active, every workspace sees its banner in Studio. */
export const platformIncidents = pgTable(
  'platform_incidents',
  {
    id: id(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    severity: text('severity', { enum: INCIDENT_SEVERITIES }).notNull(),
    status: text('status', { enum: ['active', 'resolved'] })
      .notNull()
      .default('active'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
    createdBy: uuid('created_by').references(() => platformOperators.id),
    resolvedBy: uuid('resolved_by').references(() => platformOperators.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'platform_incidents_resolved_ck',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`,
    ),
    index('platform_incidents_active_idx').on(t.startedAt).where(sql`${t.status} = 'active'`),
    pgPolicy('platform_manage', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
