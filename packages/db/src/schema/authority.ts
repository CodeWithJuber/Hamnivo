import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, platformRead, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals, secrets, staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * A tenant's link to its conversation authority (Chatwoot CE account). Conversations, messages
 * and contacts live there; these tables hold only control state, ledgers and a short-lived journal.
 */
export const authorityConnections = pgTable(
  'authority_connections',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind', { enum: ['chatwoot'] })
      .notNull()
      .default('chatwoot'),
    baseUrl: text('base_url').notNull(),
    accountId: integer('account_id').notNull(),
    status: text('status', { enum: ['provisioning', 'active', 'degraded', 'disabled'] })
      .notNull()
      .default('provisioning'),
    authorityVersion: text('authority_version'),
    capabilities: jsonb('capabilities').notNull().default({}),
    webhookSecretId: uuid('webhook_secret_id'),
    botTokenSecretId: uuid('bot_token_secret_id'),
    integrationTokenSecretId: uuid('integration_token_secret_id'),
    adminTokenSecretId: uuid('admin_token_secret_id'),
    health: jsonb('health').notNull().default({}),
    lastHealthAt: tstz('last_health_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('authority_connections_tenant_id_id_key').on(t.tenantId, t.id),
    // One Chatwoot account belongs to exactly one Hamnivo tenant.
    uniqueIndex('authority_connections_account_key').on(t.baseUrl, t.accountId),
    foreignKey({
      name: 'authority_connections_webhook_secret_fk',
      columns: [t.tenantId, t.webhookSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'authority_connections_bot_secret_fk',
      columns: [t.tenantId, t.botTokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'authority_connections_integration_secret_fk',
      columns: [t.tenantId, t.integrationTokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'authority_connections_admin_secret_fk',
      columns: [t.tenantId, t.adminTokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    tenantIsolation(),
    platformRead(),
  ],
);

export const authorityInboxes = pgTable(
  'authority_inboxes',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    brandId: uuid('brand_id'),
    /** `import` inboxes have no webhooks, bot or automation (migration, M01–M08). */
    purpose: text('purpose', { enum: ['live', 'import'] }).notNull(),
    externalInboxId: integer('external_inbox_id').notNull(),
    /** Client API inbox identifier (API channel). */
    inboxIdentifier: text('inbox_identifier'),
    hmacSecretId: uuid('hmac_secret_id'),
    /** Secret that signs this API inbox's webhook deliveries. */
    webhookSecretId: uuid('webhook_secret_id'),
    channelType: text('channel_type').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('authority_inboxes_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('authority_inboxes_external_key').on(t.tenantId, t.connectionId, t.externalInboxId),
    foreignKey({
      name: 'authority_inboxes_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'authority_inboxes_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'authority_inboxes_hmac_secret_fk',
      columns: [t.tenantId, t.hmacSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'authority_inboxes_webhook_secret_fk',
      columns: [t.tenantId, t.webhookSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    tenantIsolation(),
  ],
);

/** Chatwoot Agent Bots that carry Hamnivo AI profiles (one per publicly speaking profile). */
export const authorityBots = pgTable(
  'authority_bots',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    externalBotId: integer('external_bot_id').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: ['primary', 'specialist'] }).notNull(),
    agentProfileId: uuid('agent_profile_id'),
    accessTokenSecretId: uuid('access_token_secret_id').notNull(),
    /** Secret that signs this bot's webhook deliveries. */
    webhookSecretId: uuid('webhook_secret_id'),
    status: text('status', { enum: ['active', 'detached', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('authority_bots_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('authority_bots_external_key').on(t.tenantId, t.connectionId, t.externalBotId),
    foreignKey({
      name: 'authority_bots_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'authority_bots_secret_fk',
      columns: [t.tenantId, t.accessTokenSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    foreignKey({
      name: 'authority_bots_webhook_secret_fk',
      columns: [t.tenantId, t.webhookSecretId],
      foreignColumns: [secrets.tenantId, secrets.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * A customer principal's Chatwoot contact in one inbox. The contact-inbox `source_id` grants
 * Client API access to the conversation, so it is stored encrypted and never sent to browsers.
 */
export const authorityContacts = pgTable(
  'authority_contacts',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    inboxId: uuid('inbox_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    /** Null until Chatwoot confirmed the contact (the source id is stored first, so retries reuse it). */
    externalContactId: integer('external_contact_id'),
    /** `hv:{brand}:{sub}` for verified customers, `hv:anon:{principal}` otherwise. */
    identifier: text('identifier').notNull(),
    sourceIdCiphertext: bytea('source_id_ciphertext').notNull(),
    sourceIdIv: bytea('source_id_iv').notNull(),
    kekVersion: integer('kek_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('authority_contacts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('authority_contacts_principal_key').on(
      t.tenantId,
      t.connectionId,
      t.inboxId,
      t.principalId,
    ),
    foreignKey({
      name: 'authority_contacts_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'authority_contacts_inbox_fk',
      columns: [t.tenantId, t.inboxId],
      foreignColumns: [authorityInboxes.tenantId, authorityInboxes.id],
    }),
    foreignKey({
      name: 'authority_contacts_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    tenantIsolation(),
  ],
);

/** Staff member ↔ Chatwoot user, so staff actions run under their own Chatwoot identity. */
export const staffAuthorityLinks = pgTable(
  'staff_authority_links',
  {
    id: id(),
    tenantId: tenantId(),
    staffMemberId: uuid('staff_member_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalUserId: integer('external_user_id').notNull(),
    /** Hamnivo never adopts a Chatwoot user it did not create. */
    provisionedByHamnivo: boolean('provisioned_by_hamnivo').notNull().default(true),
    authorityRole: text('authority_role', { enum: ['agent', 'administrator'] }).notNull(),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('staff_authority_links_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('staff_authority_links_staff_key').on(t.tenantId, t.connectionId, t.staffMemberId),
    uniqueIndex('staff_authority_links_user_key').on(t.tenantId, t.connectionId, t.externalUserId),
    foreignKey({
      name: 'staff_authority_links_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'staff_authority_links_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    tenantIsolation(),
  ],
);

export const OWNER_MODES = ['AI_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'PAUSED'] as const;
export type OwnerMode = (typeof OWNER_MODES)[number];

/**
 * Hamnivo's control record for one Chatwoot conversation: who may speak (owner mode + epoch
 * fencing, ADR 0003), the realtime journal cursor and the last authority state applied.
 */
export const conversationControls = pgTable(
  'conversation_controls',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    inboxId: uuid('inbox_id').notNull(),
    brandId: uuid('brand_id'),
    principalId: uuid('principal_id'),
    /** Chatwoot conversation display id (per account). */
    externalConversationId: integer('external_conversation_id').notNull(),
    ownerMode: text('owner_mode', { enum: OWNER_MODES }).notNull(),
    ownershipEpoch: bigint('ownership_epoch', { mode: 'number' }).notNull().default(0),
    /**
     * Last epoch whose owner change Chatwoot has applied. While it trails `ownership_epoch`, the
     * authority's owner fields are stale and must not be read back as a new takeover.
     */
    ownerSyncedEpoch: bigint('owner_synced_epoch', { mode: 'number' }).notNull().default(0),
    ownerStaffId: uuid('owner_staff_id'),
    /** A Chatwoot user who took over in Chatwoot and has no Hamnivo staff link. */
    ownerExternalUserId: integer('owner_external_user_id'),
    ownerBotId: uuid('owner_bot_id'),
    /** Why the current owner has it (the last ownership change), and when that happened. */
    ownerReason: text('owner_reason'),
    ownerChangedAt: tstz('owner_changed_at'),
    leaseHolder: text('lease_holder'),
    leaseExpiresAt: tstz('lease_expires_at'),
    authorityStatus: text('authority_status', {
      enum: ['open', 'pending', 'resolved', 'snoozed'],
    }).notNull(),
    /** Chatwoot's float `updated_at`; state is applied only when newer. */
    authorityUpdatedAt: doublePrecision('authority_updated_at'),
    /** Journal heads per lane; each lane is gapless, so a customer stream reveals nothing else. */
    journalSeq: bigint('journal_seq', { mode: 'number' }).notNull().default(0),
    staffJournalSeq: bigint('staff_journal_seq', { mode: 'number' }).notNull().default(0),
    agentJournalSeq: bigint('agent_journal_seq', { mode: 'number' }).notNull().default(0),
    lastCustomerMessageAt: tstz('last_customer_message_at'),
    /**
     * The message guard's limits on its own output, read and set under this row's lock in the
     * transaction that queues the note or reserves the wording: when people were last sent an
     * urgent note (at most one in 10 minutes), and when the customer was last sent safety wording
     * (at most one in 24 hours).
     */
    safetyAlertedAt: tstz('safety_alerted_at'),
    safetyWordedAt: tstz('safety_worded_at'),
    lastActivityAt: tstz('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversation_controls_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('conversation_controls_external_key').on(
      t.tenantId,
      t.connectionId,
      t.externalConversationId,
    ),
    index('conversation_controls_principal_idx').on(t.tenantId, t.principalId),
    foreignKey({
      name: 'conversation_controls_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    foreignKey({
      name: 'conversation_controls_inbox_fk',
      columns: [t.tenantId, t.inboxId],
      foreignColumns: [authorityInboxes.tenantId, authorityInboxes.id],
    }),
    foreignKey({
      name: 'conversation_controls_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'conversation_controls_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'conversation_controls_owner_staff_fk',
      columns: [t.tenantId, t.ownerStaffId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'conversation_controls_owner_bot_fk',
      columns: [t.tenantId, t.ownerBotId],
      foreignColumns: [authorityBots.tenantId, authorityBots.id],
    }),
    check(
      'conversation_controls_owner_mode_ck',
      sql`${t.ownerMode} in ('AI_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'PAUSED')`,
    ),
    check(
      'conversation_controls_human_owner_ck',
      sql`${t.ownerMode} <> 'HUMAN_ACTIVE' or ${t.ownerStaffId} is not null or ${t.ownerExternalUserId} is not null`,
    ),
    tenantIsolation(),
  ],
);

export const LEDGER_STATES = ['pending', 'committed', 'unknown', 'failed'] as const;

/**
 * Idempotency ledger for messages Hamnivo writes to the authority. A timeout leaves the row
 * `unknown`; it is resolved by looking up `source_key` in Chatwoot, never by re-posting blindly.
 */
export const messageLedger = pgTable(
  'message_ledger',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    senderKind: text('sender_kind', { enum: ['customer', 'staff', 'ai', 'system'] }).notNull(),
    senderId: text('sender_id').notNull(),
    clientMessageId: uuid('client_message_id').notNull(),
    requestHash: bytea('request_hash').notNull(),
    state: text('state', { enum: LEDGER_STATES }).notNull().default('pending'),
    /** Sent to Chatwoot as `source_id` (`hv1:m:{id}`); echoed back in webhooks. */
    sourceKey: text('source_key').notNull(),
    authorityMessageId: bigint('authority_message_id', { mode: 'number' }),
    errorCode: text('error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    committedAt: tstz('committed_at'),
  },
  (t) => [
    unique('message_ledger_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('message_ledger_client_key').on(
      t.tenantId,
      t.conversationId,
      t.senderKind,
      t.senderId,
      t.clientMessageId,
    ),
    uniqueIndex('message_ledger_source_key').on(t.sourceKey),
    index('message_ledger_open_idx')
      .on(t.tenantId, t.state)
      .where(sql`${t.state} in ('pending', 'unknown')`),
    foreignKey({
      name: 'message_ledger_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    check(
      'message_ledger_state_ck',
      sql`${t.state} in ('pending', 'committed', 'unknown', 'failed')`,
    ),
    tenantIsolation(),
  ],
);

export const PUBLICATION_STATES = [
  'reserved',
  'sent',
  'late_publication',
  'aborted',
  'unknown',
] as const;

/** Fenced AI publications (ADR 0003): reserved under the epoch, then sent or aborted. */
export const publications = pgTable(
  'publications',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    runId: uuid('run_id'),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    state: text('state', { enum: PUBLICATION_STATES }).notNull().default('reserved'),
    sourceKey: text('source_key').notNull(),
    contentHash: bytea('content_hash').notNull(),
    authorityMessageId: bigint('authority_message_id', { mode: 'number' }),
    detail: jsonb('detail').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    sentAt: tstz('sent_at'),
  },
  (t) => [
    unique('publications_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('publications_source_key').on(t.sourceKey),
    index('publications_conversation_idx').on(t.tenantId, t.conversationId, t.epoch),
    foreignKey({
      name: 'publications_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    check(
      'publications_state_ck',
      sql`${t.state} in ('reserved', 'sent', 'late_publication', 'aborted', 'unknown')`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Customer ratings of resolved conversations (W15): one per customer and conversation, and a new
 * rating replaces the previous one. Staff also see each rating as a private note in Chatwoot.
 */
export const conversationFeedback = pgTable(
  'conversation_feedback',
  {
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'conversation_feedback_pkey',
      columns: [t.tenantId, t.conversationId, t.principalId],
    }),
    foreignKey({
      name: 'conversation_feedback_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_feedback_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check('conversation_feedback_rating_ck', sql`${t.rating} between 1 and 5`),
    tenantIsolation(),
  ],
);

/** Verified inbound authority events, deduplicated and acknowledged before processing. */
export const integrationInbox = pgTable(
  'integration_inbox',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    source: text('source', { enum: ['account', 'bot', 'inbox', 'reconciler'] }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    eventType: text('event_type').notNull(),
    deliveryId: text('delivery_id'),
    payload: jsonb('payload').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    availableAt: tstz('available_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    processedAt: tstz('processed_at'),
    lastError: text('last_error'),
  },
  (t) => [
    unique('integration_inbox_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('integration_inbox_dedupe_key').on(t.tenantId, t.connectionId, t.dedupeKey),
    index('integration_inbox_pending_idx').on(t.availableAt).where(sql`${t.processedAt} is null`),
    foreignKey({
      name: 'integration_inbox_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Realtime journal: an ordered, short-lived projection that SSE clients replay by `seq`
 * (ADR 0004). Not a transcript: rows expire (7 days by default) and are redacted on deletes.
 */
export const conversationJournal = pgTable(
  'conversation_journal',
  {
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    lane: text('lane', { enum: ['customer', 'staff', 'agent_work'] }).notNull(),
    eventType: text('event_type').notNull(),
    event: jsonb('event').notNull(),
    authorityCreatedAt: tstz('authority_created_at'),
    authorityId: bigint('authority_id', { mode: 'number' }),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'conversation_journal_pkey',
      columns: [t.tenantId, t.conversationId, t.lane, t.seq],
    }),
    index('conversation_journal_expires_idx').on(t.expiresAt),
    foreignKey({
      name: 'conversation_journal_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    check('conversation_journal_lane_ck', sql`${t.lane} in ('customer', 'staff', 'agent_work')`),
    tenantIsolation(),
  ],
);

/** Adaptive reconciler cursors: webhooks reduce latency, polling guarantees completeness. */
export const reconcileCursors = pgTable(
  'reconcile_cursors',
  {
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    scope: text('scope', { enum: ['conversation', 'inbox'] }).notNull(),
    scopeRef: text('scope_ref').notNull(),
    lastExternalId: bigint('last_external_id', { mode: 'number' }),
    lastAuthorityUpdatedAt: doublePrecision('last_authority_updated_at'),
    intervalSeconds: integer('interval_seconds').notNull().default(30),
    nextPollAt: tstz('next_poll_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'reconcile_cursors_pkey',
      columns: [t.tenantId, t.connectionId, t.scope, t.scopeRef],
    }),
    index('reconcile_cursors_due_idx').on(t.nextPollAt),
    foreignKey({
      name: 'reconcile_cursors_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    tenantIsolation(),
  ],
);
