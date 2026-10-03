import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  bytea,
  createdAt,
  id,
  platformRead,
  platformRole,
  tenantIsolation,
  tstz,
  updatedAt,
} from './helpers.js';
import { staffMembers } from './identity.js';
import { platformOperators } from './operators.js';
import { brands, tenantId } from './tenancy.js';

/**
 * Running one Hamnivo install as a service for many businesses (SaaS). Two tables are global
 * platform data on the RLS suite's allowlist: platform settings (the sign-up switch) and the
 * operator API keys a billing system such as WHMCS uses. The others are tenant data: how a
 * workspace pays and what its billing provider reported, the provider events applied once each,
 * the automatic Chatwoot set-up of a brand and the sender name of the workspace's emails.
 */

const platformManage = () =>
  pgPolicy('platform_manage', {
    as: 'permissive',
    for: 'all',
    to: platformRole,
    using: sql`true`,
    withCheck: sql`true`,
  });

/** Platform-wide settings changed in the platform console, one row per key. */
export const platformSettings = pgTable(
  'platform_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by').references(() => platformOperators.id),
    updatedAt: updatedAt(),
  },
  () => [platformManage()],
);

/**
 * Keys for the operator API (`Authorization: Bearer hvop_…`), used by billing systems. Only an
 * HMAC of the secret is stored; a key is revoked, never deleted, so the audit trail keeps its name.
 */
export const operatorApiKeys = pgTable(
  'operator_api_keys',
  {
    id: id(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: bytea('secret_hash').notNull(),
    hashVersion: integer('hash_version').notNull(),
    createdBy: uuid('created_by').references(() => platformOperators.id),
    createdAt: createdAt(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => platformOperators.id),
  },
  (t) => [uniqueIndex('operator_api_keys_prefix_key').on(t.prefix), platformManage()],
);

export const BILLING_PROVIDERS = ['free', 'stripe', 'whmcs', 'manual'] as const;
export type BillingProviderKind = (typeof BILLING_PROVIDERS)[number];

/** Subscription states as Stripe names them; `none` is a workspace without a subscription. */
export const SUBSCRIPTION_STATUSES = [
  'none',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * How a workspace pays: the provider, its customer and subscription references and the state the
 * provider reported last. The plan itself lives in tenant_entitlements; this row decides which
 * plan the provider pays for and until when a failed payment keeps it (grace period).
 */
export const billingAccounts = pgTable(
  'billing_accounts',
  {
    id: id(),
    tenantId: tenantId(),
    provider: text('provider', { enum: BILLING_PROVIDERS }).notNull().default('free'),
    /** Stripe customer (`cus_…`) or WHMCS client id. */
    customerRef: text('customer_ref'),
    /** Stripe subscription (`sub_…`) or WHMCS service id. */
    subscriptionRef: text('subscription_ref'),
    subscriptionStatus: text('subscription_status', { enum: SUBSCRIPTION_STATUSES })
      .notNull()
      .default('none'),
    /** The Hamnivo plan the provider bills for. */
    planKey: text('plan_key'),
    currentPeriodEnd: tstz('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** The first failed payment of the current dunning cycle; null once paid. */
    paymentFailedAt: tstz('payment_failed_at'),
    /** Until when the plan stays after a failed payment; then the workspace falls back to free. */
    graceEndsAt: tstz('grace_ends_at'),
    /** When the provider made the newest change applied here (events arrive in any order). */
    providerUpdatedAt: tstz('provider_updated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('billing_accounts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('billing_accounts_tenant_key').on(t.tenantId),
    // One Stripe customer per workspace; a WHMCS client may own several workspaces.
    uniqueIndex('billing_accounts_stripe_customer_key')
      .on(t.customerRef)
      .where(sql`${t.provider} = 'stripe' and ${t.customerRef} is not null`),
    uniqueIndex('billing_accounts_subscription_key')
      .on(t.provider, t.subscriptionRef)
      .where(sql`${t.subscriptionRef} is not null`),
    index('billing_accounts_grace_idx').on(t.graceEndsAt).where(sql`${t.graceEndsAt} is not null`),
    tenantIsolation(),
    platformRead(),
  ],
);

/**
 * Billing-provider events applied to a workspace, once each: the key that makes a redelivered
 * webhook a no-op, and the record of what billing did with it. Written once, never changed.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    tenantId: tenantId(),
    provider: text('provider', { enum: BILLING_PROVIDERS }).notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    /** `applied`, `stale` (older than what was applied) or `ignored`. */
    outcome: text('outcome', { enum: ['applied', 'stale', 'ignored'] }).notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'billing_events_pkey', columns: [t.tenantId, t.provider, t.eventId] }),
    index('billing_events_received_idx').on(t.tenantId, t.receivedAt),
    tenantIsolation(),
  ],
);

export const PROVISIONING_STATES = [
  'queued',
  'running',
  'connected',
  'failed',
  'not_configured',
] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

/**
 * The automatic Chatwoot set-up of a brand (one account per brand, ADR 0001) and the progress
 * Studio shows. The connection id is fixed before the first call, every completed step is
 * recorded (ids and secret ids, never secrets), and a lease keeps two runs from overlapping, so a
 * retry continues where the last attempt stopped instead of creating a second account.
 */
export const chatwootProvisioning = pgTable(
  'chatwoot_provisioning',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    state: text('state', { enum: PROVISIONING_STATES }).notNull().default('queued'),
    /** The last step completed. */
    step: text('step'),
    attempts: integer('attempts').notNull().default(0),
    /** A safe summary of the last failure: no secrets, no response bodies. */
    lastError: text('last_error'),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    /** What started it: `tenant.created`, `brand.created` or `manual`. */
    trigger: text('trigger').notNull(),
    lockedUntil: tstz('locked_until'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('chatwoot_provisioning_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('chatwoot_provisioning_brand_key').on(t.tenantId, t.brandId),
    foreignKey({
      name: 'chatwoot_provisioning_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check('chatwoot_provisioning_attempts_ck', sql`${t.attempts} >= 0`),
    tenantIsolation(),
    platformRead(),
  ],
);

/** The display name a workspace's emails are sent with (the address stays the server's). */
export const workspaceEmailSettings = pgTable(
  'workspace_email_settings',
  {
    id: id(),
    tenantId: tenantId(),
    senderName: text('sender_name').notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('workspace_email_settings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('workspace_email_settings_tenant_key').on(t.tenantId),
    foreignKey({
      name: 'workspace_email_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('workspace_email_settings_sender_ck', sql`char_length(${t.senderName}) between 1 and 80`),
    tenantIsolation(),
  ],
);
