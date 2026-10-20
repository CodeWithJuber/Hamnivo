import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, tenantIsolation, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { tenants } from './tenancy.js';

export interface AgencyBranding {
  displayName: string | null;
  accentColor: string | null;
}

/** Agency mode is an opt-in property of a tenant; it never changes child tenant ownership. */
export const agencyConfigs = pgTable(
  'agency_configs',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    enabled: boolean('enabled').notNull().default(false),
    branding: jsonb('branding')
      .$type<AgencyBranding>()
      .notNull()
      .default({ displayName: null, accentColor: null }),
    clientLimit: integer('client_limit'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'agency_configs_client_limit_ck',
      sql`${t.clientLimit} is null or ${t.clientLimit} between 1 and 1000`,
    ),
    tenantIsolation(),
  ],
);

/** Directory links only. Access to a client is governed by that tenant's own staff grants. */
export const agencyClients = pgTable(
  'agency_clients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clientTenantId: uuid('client_tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'agency_clients_pkey', columns: [t.tenantId, t.clientTenantId] }),
    uniqueIndex('agency_clients_one_parent_key').on(t.clientTenantId),
    foreignKey({
      name: 'agency_clients_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('agency_clients_not_self_ck', sql`${t.tenantId} <> ${t.clientTenantId}`),
    tenantIsolation(),
  ],
);

/** Explicit AI funding for newly created clients. Removing a directory link does not move billing. */
export const agencyClientFunding = pgTable(
  'agency_client_funding',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    payerTenantId: uuid('payer_tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('agency_client_funding_not_self_ck', sql`${t.tenantId} <> ${t.payerTenantId}`),
    tenantIsolation(),
  ],
);
