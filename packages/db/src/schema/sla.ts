import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { teams } from './inbox.js';
import { brands, tenantId } from './tenancy.js';

/** Minutes for the first and the next reply, per priority (the `SlaTargets` contract). */
export type SlaTargetsJson = Record<
  'urgent' | 'high' | 'medium' | 'low',
  { firstReplyMinutes: number | null; nextReplyMinutes: number | null }
>;

/**
 * A brand's reply-time targets (H12): how soon a person should give the first and each next reply,
 * per priority, counted in the brand's business hours. A brand with no row has no targets. When a
 * conversation goes past its target, the people who can assign it may be alerted, and it may be
 * moved back to the queue or to another team after more working minutes (ADR 0016).
 */
export const slaPolicies = pgTable(
  'sla_policies',
  {
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    targets: jsonb('targets').$type<SlaTargetsJson>().notNull(),
    /** Alert the people who can assign an overdue conversation (ADR 0016). */
    overdueAlertLeads: boolean('overdue_alert_leads').notNull().default(false),
    /** Working minutes after it went overdue before it is moved; null: never moved. */
    overdueMoveAfterMinutes: integer('overdue_move_after_minutes'),
    /** The team it is moved to; null: back to the queue, keeping its team. */
    overdueMoveTeamId: uuid('overdue_move_team_id'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'sla_policies_pkey', columns: [t.tenantId, t.brandId] }),
    check('sla_policies_targets_ck', sql`jsonb_typeof(${t.targets}) = 'object'`),
    check(
      'sla_policies_overdue_move_ck',
      sql`${t.overdueMoveAfterMinutes} is null or ${t.overdueMoveAfterMinutes} between 1 and 10080`,
    ),
    foreignKey({
      name: 'sla_policies_overdue_team_fk',
      columns: [t.tenantId, t.overdueMoveTeamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    foreignKey({
      name: 'sla_policies_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'sla_policies_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const SLA_OUTCOMES = ['met', 'missed', 'stopped'] as const;

/**
 * How each reply-time clock ended (H12, O04), for reports: one row per clock, written when it ends.
 * `met` and `missed` mean a person replied before or after the deadline; `stopped` means the clock
 * ended without a person's reply (the AI took the chat back, or it was resolved). Rows are never
 * changed; they are removed 13 months after the clock ended.
 */
export const slaOutcomes = pgTable(
  'sla_outcomes',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind', { enum: ['first_reply', 'next_reply'] }).notNull(),
    priority: text('priority', { enum: ['urgent', 'high', 'medium', 'low'] }).notNull(),
    targetMinutes: integer('target_minutes').notNull(),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at').notNull(),
    outcome: text('outcome', { enum: SLA_OUTCOMES }).notNull(),
    /** Working minutes from start to end, without the time spent snoozed. */
    businessMinutes: integer('business_minutes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sla_outcomes_tenant_id_id_key').on(t.tenantId, t.id),
    index('sla_outcomes_ended_idx').on(t.tenantId, t.endedAt),
    index('sla_outcomes_conversation_idx').on(t.tenantId, t.conversationId),
    /** The 13-month purge looks across tenants by end time. */
    index('sla_outcomes_purge_idx').on(t.endedAt),
    check('sla_outcomes_minutes_ck', sql`${t.targetMinutes} > 0 and ${t.businessMinutes} >= 0`),
    foreignKey({
      name: 'sla_outcomes_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    tenantIsolation(),
  ],
);
