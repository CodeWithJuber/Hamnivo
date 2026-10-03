import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  citext,
  createdAt,
  id,
  platformRead,
  platformRole,
  tenantIsolation,
  tstz,
  updatedAt,
} from './helpers.js';
import { staffMembers } from './identity.js';
import { tenantId, tenants } from './tenancy.js';

/**
 * Plans, entitlements and platform invoices (A08, A15, A16). `plans` and `invoices` are global
 * platform data on the RLS suite's allowlist: the application role cannot touch them, the platform
 * operator manages them through the platform role, and a tenant reads its own invoices only
 * through app.tenant_invoices(). A tenant's entitlements are tenant data: the plan's limits as
 * assigned (a copy, so a later plan edit changes nothing silently) and the tenant's own budget.
 */

/** Limits are `{ conversations, aiReplies, aiTokens, knowledgeStorageBytes, seats, webhookEndpoints }`, null for unlimited. */
export type LimitsJson = Record<string, number | null>;
export interface MeteredPriceJson {
  limit: 'conversations' | 'aiReplies' | 'aiTokens';
  includedUnits: number;
  unitPriceMinor: string;
  perUnits: number;
}

const platformManage = () =>
  pgPolicy('platform_manage', {
    as: 'permissive',
    for: 'all',
    to: platformRole,
    using: sql`true`,
    withCheck: sql`true`,
  });

export const plans = pgTable(
  'plans',
  {
    id: id(),
    key: citext('key').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    limits: jsonb('limits').$type<LimitsJson>().notNull(),
    metered: jsonb('metered').$type<MeteredPriceJson[]>().notNull().default([]),
    status: text('status', { enum: ['active', 'retired'] })
      .notNull()
      .default('active'),
    /** Days a workspace may try the plan before it falls back to the free plan; 0: no trial. */
    trialDays: integer('trial_days').notNull().default(0),
    /** The Stripe price a subscription to this plan uses (`price_…`); null: not sold on Stripe. */
    stripePriceId: text('stripe_price_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('plans_key_key').on(t.key),
    uniqueIndex('plans_stripe_price_key')
      .on(t.stripePriceId)
      .where(sql`${t.stripePriceId} is not null`),
    check('plans_price_ck', sql`${t.priceMinor} >= 0`),
    check('plans_trial_ck', sql`${t.trialDays} between 0 and 365`),
    platformManage(),
  ],
);

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    number: text('number').notNull(),
    periodKey: text('period_key').notNull(),
    periodStart: tstz('period_start').notNull(),
    periodEnd: tstz('period_end').notNull(),
    planKey: text('plan_key').notNull(),
    planName: text('plan_name').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    lines: jsonb('lines').$type<Record<string, unknown>[]>().notNull(),
    usage: jsonb('usage').$type<Record<string, number>>().notNull(),
    issuedAt: tstz('issued_at'),
    dueAt: tstz('due_at'),
    paidAt: tstz('paid_at'),
    voidedAt: tstz('voided_at'),
    voidReason: text('void_reason'),
    paymentMethod: text('payment_method', { enum: ['manual', 'provider'] })
      .notNull()
      .default('manual'),
    paymentState: text('payment_state', { enum: ['none', 'pending', 'failed', 'paid'] })
      .notNull()
      .default('none'),
    paymentReference: text('payment_reference'),
    paymentFailedAt: tstz('payment_failed_at'),
    nextPaymentRetryAt: tstz('next_payment_retry_at'),
    /** The operator (or `system`) that created the invoice. */
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('invoices_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('invoices_number_key').on(t.number),
    uniqueIndex('invoices_period_key')
      .on(t.tenantId, t.periodKey)
      .where(sql`${t.status} <> 'void'`),
    index('invoices_tenant_idx').on(t.tenantId, t.periodStart),
    check('invoices_amounts_ck', sql`${t.subtotalMinor} >= 0 and ${t.totalMinor} >= 0`),
    check(
      'invoices_lifecycle_ck',
      sql`(${t.status} in ('issued', 'paid')) <= (${t.issuedAt} is not null and ${t.dueAt} is not null)
        and (${t.status} = 'paid') = (${t.paidAt} is not null)
        and (${t.status} = 'void') = (${t.voidedAt} is not null)`,
    ),
    platformManage(),
  ],
);

/**
 * What a tenant may use: the assigned plan's limits (copied when assigned) and the tenant's own
 * AI budget and alert thresholds. No row, or no plan: nothing is limited by a plan.
 */
export const tenantEntitlements = pgTable(
  'tenant_entitlements',
  {
    id: id(),
    tenantId: tenantId(),
    planKey: text('plan_key'),
    planName: text('plan_name'),
    currency: text('currency'),
    priceMinor: bigint('price_minor', { mode: 'bigint' }),
    limits: jsonb('limits').$type<LimitsJson>().notNull().default({}),
    metered: jsonb('metered').$type<MeteredPriceJson[]>().notNull().default([]),
    assignedAt: tstz('assigned_at'),
    assignedBy: text('assigned_by'),
    /** While set, the plan is a trial that falls back to the free plan at this time. */
    trialEndsAt: tstz('trial_ends_at'),
    /** The tenant's own ceiling on AI tokens per period (A08); null: none. */
    aiTokenBudget: bigint('ai_token_budget', { mode: 'number' }),
    alertThresholds: integer('alert_thresholds')
      .array()
      .notNull()
      .default(sql`'{80,100}'::integer[]`),
    budgetUpdatedAt: tstz('budget_updated_at'),
    budgetUpdatedBy: uuid('budget_updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tenant_entitlements_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('tenant_entitlements_tenant_key').on(t.tenantId),
    foreignKey({
      name: 'tenant_entitlements_budget_updated_by_fk',
      columns: [t.tenantId, t.budgetUpdatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'tenant_entitlements_plan_ck',
      sql`(${t.planKey} is null) = (${t.planName} is null)
        and (${t.planKey} is null) = (${t.currency} is null)
        and (${t.planKey} is null) = (${t.priceMinor} is null)`,
    ),
    check(
      'tenant_entitlements_budget_ck',
      sql`${t.aiTokenBudget} is null or ${t.aiTokenBudget} >= 0`,
    ),
    tenantIsolation(),
    platformRead(),
  ],
);

/** Alerts raised when usage reached a threshold, once per limit, threshold and period. */
export const usageAlerts = pgTable(
  'usage_alerts',
  {
    id: id(),
    tenantId: tenantId(),
    limitKey: text('limit_key').notNull(),
    source: text('source', { enum: ['plan', 'budget'] }).notNull(),
    threshold: integer('threshold').notNull(),
    periodKey: text('period_key').notNull(),
    used: bigint('used', { mode: 'number' }).notNull(),
    max: bigint('max', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('usage_alerts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('usage_alerts_once_key').on(
      t.tenantId,
      t.limitKey,
      t.source,
      t.periodKey,
      t.threshold,
    ),
    tenantIsolation(),
  ],
);
