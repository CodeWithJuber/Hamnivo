import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { bytea, citext, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { customerPrincipals } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * The customer surface of the chat widget: brand settings for layout, files, help, deletion,
 * notifications (W02, W09, W17, W23, W25) and proactive prompts (W19), files in quarantine,
 * read state in both directions (W05, W06) and email notifications (W25).
 */

/**
 * A brand's widget settings and proactive prompts, each validated by its contract before it is
 * stored. Missing values mean the contract's defaults; proactive prompts are off until set.
 */
export const brandWidgetSettings = pgTable(
  'brand_widget_settings',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    /** WidgetSettings (layout, attachments, help, deletion, notifications). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** ProactiveSettings; `{}` is "off". */
    proactive: jsonb('proactive').$type<Record<string, unknown>>().notNull().default({}),
    /** WidgetForms: the pre-chat form (W26) and the contact form (W11); `{}` is the defaults. */
    forms: jsonb('forms').$type<Record<string, unknown>>().notNull().default({}),
    /** ConsentSettings (W27); `{}` is "off". */
    consent: jsonb('consent').$type<Record<string, unknown>>().notNull().default({}),
    /** Goes up whenever the consent words change, so customers agree to the new words. */
    consentVersion: integer('consent_version').notNull().default(0),
    /** The direct chat link (W28) is on. */
    directLink: boolean('direct_link').notNull().default(false),
    settingsUpdatedAt: tstz('settings_updated_at'),
    proactiveUpdatedAt: tstz('proactive_updated_at'),
    formsUpdatedAt: tstz('forms_updated_at'),
    consentUpdatedAt: tstz('consent_updated_at'),
    directLinkUpdatedAt: tstz('direct_link_updated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('brand_widget_settings_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('brand_widget_settings_brand_key').on(t.tenantId, t.brandId),
    check('brand_widget_settings_consent_version_ck', sql`${t.consentVersion} >= 0`),
    foreignKey({
      name: 'brand_widget_settings_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    tenantIsolation(),
  ],
);

export const WIDGET_UPLOAD_STATUSES = ['available', 'rejected', 'sent', 'expired'] as const;

/**
 * Files a customer uploaded (W09). The bytes wait here, in quarantine, only until the message that
 * carries them reaches the conversation authority, which then owns the file; rejected and expired
 * uploads keep no bytes. A file is `available` only after its type was read from its bytes and the
 * scanner passed it.
 */
export const widgetUploads = pgTable(
  'widget_uploads',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    /** Cleaned file name, with the extension of the detected type. */
    name: text('name').notNull(),
    /** Detected from the bytes. */
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: bytea('sha256').notNull(),
    status: text('status', { enum: WIDGET_UPLOAD_STATUSES }).notNull(),
    rejectionReason: text('rejection_reason'),
    scanEngine: text('scan_engine'),
    scannedAt: tstz('scanned_at'),
    /** Quarantined bytes; null once sent, refused or expired. */
    content: bytea('content'),
    /** The message the file was sent with (a retry of that send may reuse it). */
    clientMessageId: uuid('client_message_id'),
    authorityMessageId: bigint('authority_message_id', { mode: 'number' }),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    sentAt: tstz('sent_at'),
  },
  (t) => [
    unique('widget_uploads_tenant_id_id_key').on(t.tenantId, t.id),
    index('widget_uploads_conversation_idx').on(t.tenantId, t.conversationId),
    index('widget_uploads_expires_idx').on(t.expiresAt).where(sql`${t.content} is not null`),
    foreignKey({
      name: 'widget_uploads_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'widget_uploads_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'widget_uploads_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check(
      'widget_uploads_status_ck',
      sql`${t.status} in ('available', 'rejected', 'sent', 'expired')`,
    ),
    check('widget_uploads_size_ck', sql`${t.sizeBytes} between 1 and 10485760`),
    // Only a file that passed the scanner keeps bytes.
    check('widget_uploads_quarantine_ck', sql`${t.content} is null or ${t.status} = 'available'`),
    tenantIsolation(),
  ],
);

/**
 * How far each side has read a conversation (W05, W06): the customer's last displayed journal
 * sequence (unread counts, and Chatwoot's "seen" for staff), and the time Chatwoot reports staff
 * last saw it, with the newest customer message that time covers.
 */
export const conversationReadState = pgTable(
  'conversation_read_state',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    customerReadSeq: integer('customer_read_seq').notNull().default(0),
    customerReadAt: tstz('customer_read_at'),
    /** When the authority was last told the customer saw the conversation. */
    customerSeenSyncedAt: tstz('customer_seen_synced_at'),
    /** Chatwoot's agent_last_seen_at, as last observed. */
    agentSeenAt: tstz('agent_seen_at'),
    /** The newest customer message (msg_…) reported read. */
    agentReadMessageId: text('agent_read_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversation_read_state_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('conversation_read_state_conversation_key').on(t.tenantId, t.conversationId),
    foreignKey({
      name: 'conversation_read_state_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_read_state_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check('conversation_read_state_seq_ck', sql`${t.customerReadSeq} >= 0`),
    tenantIsolation(),
  ],
);

/** A verified customer's email choices (W25); both are off until the customer turns them on. */
export const customerNotificationPreferences = pgTable(
  'customer_notification_preferences',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    transcript: boolean('transcript').notNull().default(false),
    replyWaiting: boolean('reply_waiting').notNull().default(false),
    /** Set when an unsubscribe link turned an email off. */
    unsubscribedAt: tstz('unsubscribed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customer_notification_preferences_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('customer_notification_preferences_principal_key').on(t.tenantId, t.principalId),
    foreignKey({
      name: 'customer_notification_preferences_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'customer_notification_preferences_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    tenantIsolation(),
  ],
);

export const CUSTOMER_NOTIFICATION_KINDS = ['transcript', 'reply_waiting'] as const;

/**
 * Emails sent to customers (W25), one row per notification: the dedupe key makes a redelivered
 * job send nothing twice, and recent rows cap how often a conversation emails its customer.
 */
export const customerNotifications = pgTable(
  'customer_notifications',
  {
    id: id(),
    tenantId: tenantId(),
    principalId: uuid('principal_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind', { enum: CUSTOMER_NOTIFICATION_KINDS }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: ['sent', 'skipped'] }).notNull(),
    /** Why nothing was sent (read in time, turned off, no address…). */
    skipReason: text('skip_reason'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique('customer_notifications_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('customer_notifications_dedupe_key').on(t.tenantId, t.dedupeKey),
    index('customer_notifications_conversation_idx').on(
      t.tenantId,
      t.conversationId,
      t.kind,
      t.createdAt,
    ),
    foreignKey({
      name: 'customer_notifications_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    foreignKey({
      name: 'customer_notifications_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    check('customer_notifications_kind_ck', sql`${t.kind} in ('transcript', 'reply_waiting')`),
    check('customer_notifications_status_ck', sql`${t.status} in ('sent', 'skipped')`),
    tenantIsolation(),
  ],
);

/**
 * A customer agreed to a brand's consent words before chatting (W27). Append-only: the version
 * of the words and the time, never the country that made the question appear.
 */
export const chatConsents = pgTable(
  'chat_consents',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    noticeVersion: integer('notice_version').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('chat_consents_tenant_id_id_key').on(t.tenantId, t.id),
    index('chat_consents_principal_idx').on(t.tenantId, t.principalId, t.noticeVersion),
    foreignKey({
      name: 'chat_consents_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'chat_consents_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    check('chat_consents_version_ck', sql`${t.noticeVersion} >= 0`),
    tenantIsolation(),
  ],
);

/**
 * Where a ticket from the contact form (W11, H19) may be answered by email. The address is what
 * the customer typed: nothing is sent to it but one confirmation until they confirm it, and the
 * confirmation never carries what they wrote. The row goes with its conversation.
 */
export const ticketFollowups = pgTable(
  'ticket_followups',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    email: citext('email').notNull(),
    /** SHA-256 of the confirmation token; the token itself is only in the email. */
    confirmTokenHash: bytea('confirm_token_hash').notNull(),
    confirmationSentAt: tstz('confirmation_sent_at'),
    confirmedAt: tstz('confirmed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ticket_followups_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('ticket_followups_conversation_key').on(t.tenantId, t.conversationId),
    uniqueIndex('ticket_followups_token_key').on(t.confirmTokenHash),
    index('ticket_followups_email_idx').on(t.tenantId, t.brandId, t.email, t.confirmationSentAt),
    foreignKey({
      name: 'ticket_followups_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'ticket_followups_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ticket_followups_principal_fk',
      columns: [t.tenantId, t.principalId],
      foreignColumns: [customerPrincipals.tenantId, customerPrincipals.id],
    }),
    tenantIsolation(),
  ],
);
