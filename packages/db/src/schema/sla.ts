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
import { brands, tenantId } from './tenancy.js';

/** Minutes for the first and the next reply, per priority (the `SlaTargets` contract). */
export type SlaTargetsJson = Record<
  'urgent' | 'high' | 'medium' | 'low',
  { firstReplyMinutes: number | null; nextReplyMinutes: number | null }
>;

/**
 * A brand's reply-time targets (H12): how soon a person should give the first and each next reply,
 * per priority, counted in the brand's business hours. A brand with no row has no targets.
 */
export const slaPolicies = pgTable(
  'sla_policies',
  {
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    targets: jsonb('targets').$type<SlaTargetsJson>().notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'sla_policies_pkey', columns: [t.tenantId, t.brandId] }),
    check('sla_policies_targets_ck', sql`jsonb_typeof(${t.targets}) = 'object'`),
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
    check('sla_outcomes_minutes_ck', sql`${t.targetMinutes} > 0 and ${t.businessMinutes} >= 0`),
    foreignKey({
      name: 'sla_outcomes_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    tenantIsolation(),
  ],
);
