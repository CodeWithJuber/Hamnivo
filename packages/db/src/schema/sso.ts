import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { roleDefinitions, secrets, staffMembers } from './identity.js';
import { tenantId } from './tenancy.js';

/**
 * Enterprise sign-in (A13). A tenant proves it owns an email domain with a DNS TXT record before
 * single sign-on can serve that domain. Only one tenant can hold a verified domain: the partial
 * unique index spans every tenant, whatever row-level security lets each one see.
 */
export const ssoDomains = pgTable(
  'sso_domains',
  {
    id: id(),
    tenantId: tenantId(),
    domain: citext('domain').notNull(),
    /** Published as `_hamnivo-verification.<domain>` TXT `hamnivo-verification=<token>`. */
    verificationToken: text('verification_token').notNull(),
    verifiedAt: tstz('verified_at'),
    lastCheckedAt: tstz('last_checked_at'),
    /** Outcome of the last check: verified, not_found, lookup_failed or claimed_elsewhere. */
    lastCheckResult: text('last_check_result'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sso_domains_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('sso_domains_domain_key').on(t.tenantId, t.domain),
    uniqueIndex('sso_domains_verified_key').on(t.domain).where(sql`${t.verifiedAt} is not null`),
    check(
      'sso_domains_domain_ck',
      sql`${t.domain}::text = lower(${t.domain}::text) and length(${t.domain}::text) between 3 and 253 and position('.' in ${t.domain}::text) > 1`,
    ),
    foreignKey({
      name: 'sso_domains_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const SSO_CONNECTION_STATUSES = ['draft', 'active', 'disabled'] as const;

/**
 * An OpenID Connect identity provider for one verified domain. The client secret lives in the
 * secret broker (envelope encryption); this row holds only its id. Endpoints are discovered and
 * checked when the connection is saved.
 */
export const ssoConnections = pgTable(
  'sso_connections',
  {
    id: id(),
    tenantId: tenantId(),
    domainId: uuid('domain_id').notNull(),
    /** Better Auth provider id, part of the callback URL: the connection's public ID. */
    providerId: text('provider_id').notNull(),
    protocol: text('protocol', { enum: ['oidc'] })
      .notNull()
      .default('oidc'),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretId: uuid('client_secret_id').notNull(),
    authorizationEndpoint: text('authorization_endpoint').notNull(),
    tokenEndpoint: text('token_endpoint').notNull(),
    jwksEndpoint: text('jwks_endpoint').notNull(),
    userInfoEndpoint: text('userinfo_endpoint'),
    tokenEndpointAuth: text('token_endpoint_auth', {
      enum: ['client_secret_basic', 'client_secret_post'],
    })
      .notNull()
      .default('client_secret_basic'),
    scopes: text('scopes').array().notNull().default(sql`'{openid,email,profile}'::text[]`),
    status: text('status', { enum: SSO_CONNECTION_STATUSES }).notNull().default('draft'),
    /** People with an address in the domain must use single sign-on (no password or passkey). */
    ssoOnly: boolean('sso_only').notNull().default(false),
    /** Just-in-time membership: first sign-ins join with this role at tenant level. */
    jitRoleId: uuid('jit_role_id'),
    /** The person who chose the role; new members' grants are delegated by them (A03). */
    jitGrantedBy: uuid('jit_granted_by'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sso_connections_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('sso_connections_provider_key').on(t.providerId),
    uniqueIndex('sso_connections_domain_key').on(t.tenantId, t.domainId),
    foreignKey({
      name: 'sso_connections_domain_fk',
      columns: [t.tenantId, t.domainId],
      foreignColumns: [ssoDomains.tenantId, ssoDomains.id],
    }),
    foreignKey({
      name: 'sso_connections_secret_fk',
      columns: [t.tenantId, t.clientSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'sso_connections_jit_role_fk',
      columns: [t.tenantId, t.jitRoleId],
      foreignColumns: [roleDefinitions.tenantId, roleDefinitions.id],
    }),
    foreignKey({
      name: 'sso_connections_jit_granted_by_fk',
      columns: [t.tenantId, t.jitGrantedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'sso_connections_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('sso_connections_jit_ck', sql`(${t.jitRoleId} is null) = (${t.jitGrantedBy} is null)`),
    check('sso_connections_sso_only_ck', sql`not ${t.ssoOnly} or ${t.status} = 'active'`),
    tenantIsolation(),
  ],
);
