import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, jsonb, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tenantIsolation, updatedAt } from './helpers.js';
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
