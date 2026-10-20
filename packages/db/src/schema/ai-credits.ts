import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
  appRole,
  createdAt,
  id,
  platformRead,
  platformRole,
  tenantIsolation,
  tstz,
} from './helpers.js';
import { modelConnections } from './runtime.js';
import { tenantId, tenants } from './tenancy.js';

export const aiCreditRates = pgTable(
  'ai_credit_rates',
  {
    id: id(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    version: integer('version').notNull(),
    inputMilliCredits: integer('input_milli_credits').notNull(),
    outputMilliCredits: integer('output_milli_credits').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check('ai_credit_rates_version_check', sql`${t.version} > 0`),
    check('ai_credit_rates_input_milli_credits_check', sql`${t.inputMilliCredits} >= 0`),
    check('ai_credit_rates_output_milli_credits_check', sql`${t.outputMilliCredits} >= 0`),
    uniqueIndex('ai_credit_rates_active_key').on(t.provider, t.modelId).where(sql`${t.active}`),
    unique('ai_credit_rates_provider_model_version_key').on(t.provider, t.modelId, t.version),
    pgPolicy('platform_manage', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
    pgPolicy('app_read', { as: 'permissive', for: 'select', to: appRole, using: sql`true` }),
  ],
);

export const aiCreditAttempts = pgTable(
  'ai_credit_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    payerTenantId: uuid('payer_tenant_id')
      .notNull()
      .references(() => tenants.id),
    attemptKey: text('attempt_key').notNull(),
    source: text('source', { enum: ['managed', 'byok'] }).notNull(),
    status: text('status', { enum: ['reserved', 'settled', 'released', 'expired'] }).notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    connectionId: uuid('connection_id'),
    periodKey: text('period_key').notNull(),
    rateId: uuid('rate_id').references(() => aiCreditRates.id),
    rateVersion: integer('rate_version'),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    creditsMilli: bigint('credits_milli', { mode: 'number' }).notNull().default(0),
    attribution: jsonb('attribution').$type<Record<string, unknown>>().notNull().default({}),
    leaseToken: uuid('lease_token').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    unique('ai_credit_attempts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('ai_credit_attempts_tenant_attempt_key').on(t.tenantId, t.attemptKey),
    index('ai_credit_attempts_payer_period_idx').on(t.payerTenantId, t.periodKey, t.status),
    index('ai_credit_attempts_period_idx').on(t.tenantId, t.periodKey, t.source, t.status),
    index('ai_credit_attempts_expiry_idx')
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.status} = 'reserved'`),
    foreignKey({
      name: 'ai_credit_attempts_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [modelConnections.tenantId, modelConnections.id],
    }),
    check('ai_credit_attempts_reserved_ck', sql`${t.reservedTokens} >= 0`),
    check('ai_credit_attempts_source_check', sql`${t.source} in ('managed', 'byok')`),
    check(
      'ai_credit_attempts_status_check',
      sql`${t.status} in ('reserved', 'settled', 'released', 'expired')`,
    ),
    check(
      'ai_credit_attempts_input_tokens_check',
      sql`${t.inputTokens} is null or ${t.inputTokens} >= 0`,
    ),
    check(
      'ai_credit_attempts_output_tokens_check',
      sql`${t.outputTokens} is null or ${t.outputTokens} >= 0`,
    ),
    check('ai_credit_attempts_credits_milli_check', sql`${t.creditsMilli} >= 0`),
    tenantIsolation(),
    platformRead(),
  ],
);
