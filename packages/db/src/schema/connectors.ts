import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { toolDefinitions } from './actions.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { brandIdentityKeys, customerPrincipals, secrets, staffMembers } from './identity.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/** A native connector is one brand's approved WHMCS origin and encrypted API credential. */
export const connectorConnections = pgTable(
  'connector_connections',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    kind: text('kind', { enum: ['whmcs'] }).notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('disabled'),
    identifierSecretId: uuid('identifier_secret_id').notNull(),
    tokenSecretId: uuid('token_secret_id').notNull(),
    /** The signing key allowed to issue user-and-client widget assertions for this connection. */
    identityKeyId: uuid('identity_key_id').notNull(),
    grantVersion: integer('grant_version').notNull().default(1),
    lastTestedAt: tstz('last_tested_at'),
    lastError: text('last_error'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connector_connections_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('connector_connections_brand_origin_key').on(t.tenantId, t.brandId, t.baseUrl),
    uniqueIndex('connector_connections_identity_key_key').on(
      t.tenantId,
      t.brandId,
      t.identityKeyId,
    ),
    foreignKey({
      name: 'connector_connections_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'connector_connections_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'connector_connections_identifier_fk',
      columns: [t.tenantId, t.identifierSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'connector_connections_token_fk',
      columns: [t.tenantId, t.tokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'connector_connections_key_fk',
      columns: [t.tenantId, t.identityKeyId],
      foreignColumns: [brandIdentityKeys.tenantId, brandIdentityKeys.id],
    }),
    foreignKey({
      name: 'connector_connections_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('connector_connections_https_ck', sql`${t.baseUrl} ~ '^https://[^/?#]+/?$'`),
    check('connector_connections_version_ck', sql`${t.grantVersion} > 0`),
    tenantIsolation(),
  ],
);

/** Reviewed capability grants, with the exact tool and connection version they authorize. */
export const connectorToolGrants = pgTable(
  'connector_tool_grants',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    toolId: uuid('tool_id').notNull(),
    capability: text('capability').notNull(),
    version: integer('version').notNull(),
    enabled: text('enabled', { enum: ['yes', 'no'] })
      .notNull()
      .default('yes'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('connector_tool_grants_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('connector_tool_grants_tool_key').on(t.tenantId, t.toolId),
    uniqueIndex('connector_tool_grants_capability_key').on(
      t.tenantId,
      t.connectionId,
      t.capability,
    ),
    foreignKey({
      name: 'connector_tool_grants_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connectorConnections.tenantId, connectorConnections.id],
    }),
    foreignKey({
      name: 'connector_tool_grants_tool_fk',
      columns: [t.tenantId, t.toolId],
      foreignColumns: [toolDefinitions.tenantId, toolDefinitions.id],
    }),
    tenantIsolation(),
  ],
);

/** Recorded only when a verified JWT is accepted; expires with that proof, not chat activity. */
export const connectorIdentityBindings = pgTable(
  'connector_identity_bindings',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    userId: integer('user_id').notNull(),
    clientId: integer('client_id').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connector_identity_bindings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('connector_identity_bindings_principal_key').on(
      t.tenantId,
      t.connectionId,
      t.principalId,
    ),
    index('connector_identity_bindings_expiry_idx').on(t.expiresAt),
    foreignKey({
      name: 'connector_identity_bindings_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connectorConnections.tenantId, connectorConnections.id],
    }),
    foreignKey({
      name: 'connector_identity_bindings_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check('connector_identity_bindings_ids_ck', sql`${t.userId} > 0 and ${t.clientId} > 0`),
    tenantIsolation(),
  ],
);

/** Five-minute, customer-scoped live quote. A submitted quote cannot create a second order. */
export const connectorQuotes = pgTable(
  'connector_quotes',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    price: text('price').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'connector_quotes_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connectorConnections.tenantId, connectorConnections.id],
    }),
    foreignKey({
      name: 'connector_quotes_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    tenantIsolation(),
  ],
);

/** Durable dispatch fence. WHMCS lacks generic idempotency; uncertain writes are never resent. */
export const connectorDispatches = pgTable(
  'connector_dispatches',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    /** Erasure removes the customer link but preserves the remote-write duplicate fence. */
    principalId: uuid('principal_id'),
    fingerprint: text('fingerprint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state', { enum: ['dispatched', 'confirmed', 'rejected'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('connector_dispatches_idempotency_key').on(t.tenantId, t.idempotencyKey),
    index('connector_dispatches_pending_idx').on(
      t.tenantId,
      t.connectionId,
      t.principalId,
      t.fingerprint,
      t.state,
    ),
    foreignKey({
      name: 'connector_dispatches_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connectorConnections.tenantId, connectorConnections.id],
    }),
    foreignKey({
      name: 'connector_dispatches_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    tenantIsolation(),
  ],
);
