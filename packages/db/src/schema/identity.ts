import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
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
  citext,
  createdAt,
  id,
  platformRead,
  platformRole,
  tenantIsolation,
  tstz,
  updatedAt,
} from './helpers.js';
import { brands, tenantId } from './tenancy.js';

/** Envelope-encrypted secrets (AES-256-GCM data key wrapped by the key-encryption key). */
export const secrets = pgTable(
  'secrets',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** Last characters of the value for recognition in lists (e.g. `9f3a`); never more. */
    hint: text('hint').notNull().default(''),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    kekVersion: integer('kek_version').notNull(),
    createdAt: createdAt(),
    rotatedAt: tstz('rotated_at'),
    revokedAt: tstz('revoked_at'),
    lastUsedAt: tstz('last_used_at'),
  },
  (t) => [unique('secrets_tenant_id_id_key').on(t.tenantId, t.id), tenantIsolation()],
);

/** Keys that verify tenant-signed identity assertions for a brand (W13). */
export const brandIdentityKeys = pgTable(
  'brand_identity_keys',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    kid: text('kid').notNull(),
    alg: text('alg', { enum: ['ES256', 'EdDSA', 'RS256', 'HS256'] }).notNull(),
    publicJwk: jsonb('public_jwk'),
    secretId: uuid('secret_id'),
    status: text('status', { enum: ['active', 'retiring', 'revoked'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    retiredAt: tstz('retired_at'),
  },
  (t) => [
    unique('brand_identity_keys_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('brand_identity_keys_kid_key').on(t.tenantId, t.brandId, t.kid),
    foreignKey({
      name: 'brand_identity_keys_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'brand_identity_keys_secret_fk',
      columns: [t.tenantId, t.secretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    check(
      'brand_identity_keys_material_ck',
      sql`(${t.alg} = 'HS256' and ${t.secretId} is not null) or (${t.alg} <> 'HS256' and ${t.publicJwk} is not null)`,
    ),
    tenantIsolation(),
  ],
);

export const staffMembers = pgTable(
  'staff_members',
  {
    id: id(),
    tenantId: tenantId(),
    /** Better Auth user id; one person can be staff in several tenants. */
    authUserId: text('auth_user_id').notNull(),
    displayName: text('display_name').notNull(),
    email: citext('email').notNull(),
    /**
     * What customers see of this person in the chat (W17): a first name they chose, and an https
     * photo address. Null: the first word of the display name, and initials.
     */
    publicName: text('public_name'),
    photoUrl: text('photo_url'),
    status: text('status', { enum: ['invited', 'active', 'suspended', 'removed'] })
      .notNull()
      .default('invited'),
    mfaRequired: boolean('mfa_required').notNull().default(false),
    lastActiveAt: tstz('last_active_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('staff_members_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('staff_members_auth_user_key').on(t.tenantId, t.authUserId),
    index('staff_members_auth_user_idx').on(t.authUserId),
    tenantIsolation(),
  ],
);

export const roleDefinitions = pgTable(
  'role_definitions',
  {
    id: id(),
    tenantId: tenantId(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    permissions: text('permissions').array().notNull(),
    isPreset: boolean('is_preset').notNull().default(false),
    version: integer('version').notNull().default(1),
    /** A retired custom role: kept for the grants and audit that name it, never granted again. */
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('role_definitions_tenant_id_id_key').on(t.tenantId, t.id),
    check('role_definitions_archive_ck', sql`not (${t.isPreset} and ${t.archivedAt} is not null)`),
    uniqueIndex('role_definitions_key_key').on(t.tenantId, t.key),
    tenantIsolation(),
  ],
);

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('service_accounts_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'service_accounts_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const GRANT_SCOPES = ['tenant', 'workspace', 'brand', 'team', 'inbox'] as const;

/** A role granted to one principal (staff member or service account) at one scope. */
export const grants = pgTable(
  'grants',
  {
    id: id(),
    tenantId: tenantId(),
    staffMemberId: uuid('staff_member_id'),
    serviceAccountId: uuid('service_account_id'),
    roleId: uuid('role_id').notNull(),
    scopeType: text('scope_type', { enum: GRANT_SCOPES }).notNull(),
    scopeId: uuid('scope_id'),
    delegatedBy: uuid('delegated_by'),
    reason: text('reason'),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique('grants_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'grants_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'grants_service_account_fk',
      columns: [t.tenantId, t.serviceAccountId],
      foreignColumns: [serviceAccounts.tenantId, serviceAccounts.id],
    }),
    foreignKey({
      name: 'grants_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roleDefinitions.tenantId, roleDefinitions.id],
    }),
    foreignKey({
      name: 'grants_delegated_by_fk',
      columns: [t.tenantId, t.delegatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('grants_principal_ck', sql`num_nonnulls(${t.staffMemberId}, ${t.serviceAccountId}) = 1`),
    check('grants_scope_ck', sql`(${t.scopeType} = 'tenant') = (${t.scopeId} is null)`),
    index('grants_staff_active_idx')
      .on(t.tenantId, t.staffMemberId)
      .where(sql`${t.revokedAt} is null`),
    tenantIsolation(),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: tenantId(),
    serviceAccountId: uuid('service_account_id').notNull(),
    /** Public lookup part of the key, e.g. `hv_live_8f3k2m1qa9bc`. */
    prefix: text('prefix').notNull(),
    /**
     * HMAC-SHA256 of the secret part with a key derived from the key-encryption key of version
     * `hash_version`; the secret itself is shown once and never stored.
     */
    secretHash: bytea('secret_hash').notNull(),
    hashVersion: integer('hash_version').notNull().default(1),
    /** Permissions the key may use (a subset of what an API key can carry). */
    scopes: text('scopes').array().notNull(),
    /** Where the key's permissions apply, like a grant's scope. */
    scopeType: text('scope_type', { enum: GRANT_SCOPES }).notNull().default('tenant'),
    scopeId: uuid('scope_id'),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    /** The key that replaced this one in a rotation (this one then expires soon after). */
    replacedBy: uuid('replaced_by'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('api_keys_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('api_keys_prefix_key').on(t.prefix),
    foreignKey({
      name: 'api_keys_service_account_fk',
      columns: [t.tenantId, t.serviceAccountId],
      foreignColumns: [serviceAccounts.tenantId, serviceAccounts.id],
    }),
    foreignKey({
      name: 'api_keys_replaced_by_fk',
      columns: [t.tenantId, t.replacedBy],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'api_keys_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'api_keys_revoked_by_fk',
      columns: [t.tenantId, t.revokedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('api_keys_scope_ck', sql`(${t.scopeType} = 'tenant') = (${t.scopeId} is null)`),
    tenantIsolation(),
  ],
);

/**
 * Invitations to join a tenant with a role at a scope. The link carries `inv_<id>.<secret>`;
 * only the secret's hash is stored. Acceptance requires a signed-in person whose email address
 * was verified by a server-side challenge and matches the invitation.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: tenantId(),
    email: citext('email').notNull(),
    roleId: uuid('role_id').notNull(),
    scopeType: text('scope_type', { enum: GRANT_SCOPES }).notNull(),
    scopeId: uuid('scope_id'),
    /** Expiry of the grant created on acceptance (null = no expiry). */
    grantExpiresAt: tstz('grant_expires_at'),
    tokenHash: bytea('token_hash').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'revoked'] })
      .notNull()
      .default('pending'),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    acceptedStaffMemberId: uuid('accepted_staff_member_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invitations_tenant_id_id_key').on(t.tenantId, t.id),
    index('invitations_pending_email_idx')
      .on(t.tenantId, t.email)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: 'invitations_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roleDefinitions.tenantId, roleDefinitions.id],
    }),
    foreignKey({
      name: 'invitations_invited_by_fk',
      columns: [t.tenantId, t.invitedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'invitations_accepted_staff_fk',
      columns: [t.tenantId, t.acceptedStaffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('invitations_scope_ck', sql`(${t.scopeType} = 'tenant') = (${t.scopeId} is null)`),
    tenantIsolation(),
  ],
);

export const SUPPORT_GRANT_STATUSES = ['pending', 'approved', 'declined'] as const;
/** What a support grant lets an operator read. Support access is read-only. */
export const SUPPORT_SCOPES = ['configuration', 'conversations', 'audit'] as const;

/**
 * Time-boxed, read-only access for a platform support operator (A18). The operator asks
 * (`pending`, written through the platform role); a tenant owner approves or declines, and may
 * revoke at any time. Access runs from approval until `expires_at`, unless revoked or ended.
 */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: id(),
    tenantId: tenantId(),
    /** The platform operator who asked (platform_operators.id). */
    platformUserId: text('platform_user_id').notNull(),
    /** The operator's name when they asked, shown to the tenant. */
    operatorName: text('operator_name').notNull().default(''),
    status: text('status', { enum: SUPPORT_GRANT_STATUSES }).notNull().default('pending'),
    approvedBy: uuid('approved_by'),
    declinedBy: uuid('declined_by'),
    decidedAt: tstz('decided_at'),
    /** Optional words from the tenant with the approval or decline. */
    decisionNote: text('decision_note'),
    scopes: text('scopes').array().notNull(),
    reason: text('reason').notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(30),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    startsAt: tstz('starts_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    /** The operator ended the session early. */
    endedAt: tstz('ended_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('support_grants_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'support_grants_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'support_grants_declined_by_fk',
      columns: [t.tenantId, t.declinedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'support_grants_revoked_by_fk',
      columns: [t.tenantId, t.revokedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('support_grants_window_ck', sql`${t.expiresAt} > ${t.startsAt}`),
    check(
      'support_grants_decision_ck',
      sql`(${t.status} = 'approved') = (${t.approvedBy} is not null)
        and (${t.status} = 'declined') = (${t.declinedBy} is not null)
        and (${t.status} = 'pending') = (${t.decidedAt} is null)`,
    ),
    check(
      'support_grants_duration_ck',
      sql`${t.durationMinutes} between 5 and 1440 and cardinality(${t.scopes}) > 0`,
    ),
    index('support_grants_active_idx')
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.status} = 'approved' and ${t.revokedAt} is null and ${t.endedAt} is null`),
    tenantIsolation(),
    platformRead(),
    // The platform role may only ask: a pending, undecided request.
    pgPolicy('platform_request', {
      as: 'permissive',
      for: 'insert',
      to: platformRole,
      withCheck: sql`${t.status} = 'pending' and ${t.approvedBy} is null and ${t.declinedBy} is null and ${t.revokedAt} is null and ${t.endedAt} is null`,
    }),
    // …and end an approved session early (UPDATE is granted on ended_at only).
    pgPolicy('platform_end', {
      as: 'permissive',
      for: 'update',
      to: platformRole,
      using: sql`${t.status} = 'approved'`,
      withCheck: sql`${t.status} = 'approved'`,
    }),
  ],
);

/**
 * A customer as seen by one brand: anonymous, verified through a tenant-signed assertion, or
 * known only by the address they wrote from on a channel (email, WhatsApp, Telegram; ADR 0013).
 */
export const customerPrincipals = pgTable(
  'customer_principals',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    kind: text('kind', { enum: ['anonymous', 'verified', 'channel'] }).notNull(),
    /** The tenant's user id from a verified assertion (`sub`). */
    externalSubject: text('external_subject'),
    displayName: text('display_name'),
    /** Only from assertions with email_verified=true; never self-reported. */
    email: citext('email'),
    emailVerifiedAt: tstz('email_verified_at'),
    locale: text('locale'),
    /** Channel customers: which channel, and the address there (self-reported, never verified). */
    channelKind: text('channel_kind', { enum: ['email', 'whatsapp', 'telegram', 'other'] }),
    channelHandle: citext('channel_handle'),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at'),
    /**
     * Erased on request (A10): what identified the customer is cleared and only this stub is
     * left, because orders, which are accounting records, still point at it.
     */
    erasedAt: tstz('erased_at'),
  },
  (t) => [
    unique('customer_principals_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('customer_principals_subject_key')
      .on(t.tenantId, t.brandId, t.externalSubject)
      .where(sql`${t.externalSubject} is not null`),
    uniqueIndex('customer_principals_channel_key')
      .on(t.tenantId, t.brandId, t.channelKind, t.channelHandle)
      .where(sql`${t.channelHandle} is not null`),
    check(
      'customer_principals_channel_ck',
      sql`(${t.kind} = 'channel') = (${t.channelHandle} is not null and ${t.channelKind} is not null)`,
    ),
    foreignKey({
      name: 'customer_principals_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check(
      'customer_principals_kind_ck',
      sql`(${t.kind} = 'verified') = (${t.externalSubject} is not null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Widget sessions with rotating refresh tokens. Presenting the previous token again (reuse)
 * revokes the session; the refresh token itself is never stored, only its hash.
 */
export const widgetSessions = pgTable(
  'widget_sessions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    refreshHash: bytea('refresh_hash').notNull(),
    previousRefreshHash: bytea('previous_refresh_hash'),
    generation: integer('generation').notNull().default(0),
    hostOrigin: text('host_origin').notNull(),
    /** The brand key that verified the customer, so that revoking the key ends the session. */
    identityKeyId: uuid('identity_key_id'),
    createdAt: createdAt(),
    lastUsedAt: tstz('last_used_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    unique('widget_sessions_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'widget_sessions_identity_key_fk',
      columns: [t.tenantId, t.identityKeyId],
      foreignColumns: [brandIdentityKeys.tenantId, brandIdentityKeys.id],
    }),
    index('widget_sessions_identity_key_idx').on(t.tenantId, t.identityKeyId),
    foreignKey({
      name: 'widget_sessions_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'widget_sessions_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    index('widget_sessions_principal_idx').on(t.tenantId, t.principalId),
    tenantIsolation(),
  ],
);

/** Replay cache for identity assertion `jti` values until they expire. */
export const identityNonces = pgTable(
  'identity_nonces',
  {
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    jti: text('jti').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'identity_nonces_pkey', columns: [t.tenantId, t.brandId, t.jti] }),
    foreignKey({
      name: 'identity_nonces_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    index('identity_nonces_expires_idx').on(t.expiresAt),
    tenantIsolation(),
  ],
);
