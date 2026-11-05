import type { CustomerEmailBranding, PortalBranding } from '@hamnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { tenants } from './tenancy.js';

export const tenantBranding = pgTable(
  'tenant_branding',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    portal: jsonb('portal').$type<PortalBranding>().notNull(),
    email: jsonb('email').$type<CustomerEmailBranding>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [tenantIsolation()],
);

export const brandingDomains = pgTable(
  'branding_domains',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostname: text('hostname').notNull(),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: tstz('verified_at'),
    disabledAt: tstz('disabled_at'),
    lastCheckedAt: tstz('last_checked_at'),
    lastCheckResult: text('last_check_result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('branding_domains_hostname_check', sql`${t.hostname} = lower(${t.hostname})`),
    check(
      'branding_domains_last_check_result_check',
      sql`${t.lastCheckResult} in ('verified', 'not_found', 'lookup_failed')`,
    ),
    uniqueIndex('branding_domains_hostname_key').on(t.tenantId, t.hostname),
    uniqueIndex('branding_domains_verified_key')
      .on(t.hostname)
      .where(sql`${t.verifiedAt} is not null and ${t.disabledAt} is null`),
    tenantIsolation(),
  ],
);
