import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { tenantId } from './tenancy.js';

/**
 * What a staff member chose for the inbox: which sounds play, how loud, whether the browser may
 * show desktop alerts, and whether they are online, away or offline. One row per member; a member
 * without a row has the defaults below. The sound names are checked by the API (the set of sounds
 * is part of Studio), not here.
 */
export const AVAILABILITY_STATUSES = ['online', 'away', 'offline'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const staffInboxPreferences = pgTable(
  'staff_inbox_preferences',
  {
    tenantId: tenantId(),
    staffMemberId: uuid('staff_member_id').notNull(),
    soundMuted: boolean('sound_muted').notNull().default(false),
    /** 0 to 100. */
    soundVolume: smallint('sound_volume').notNull().default(60),
    soundNewChat: text('sound_new_chat').notNull().default('chime'),
    soundCustomerMessage: text('sound_customer_message').notNull().default('pop'),
    soundAssigned: text('sound_assigned').notNull().default('bell'),
    desktopEnabled: boolean('desktop_enabled').notNull().default(true),
    /** Show the start of the customer's message in desktop alerts. */
    desktopPreview: boolean('desktop_preview').notNull().default(true),
    /** What the person chose; whether they are really there is decided by Studio's pings. */
    availability: text('availability', { enum: AVAILABILITY_STATUSES }).notNull().default('online'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'staff_inbox_preferences_pkey', columns: [t.tenantId, t.staffMemberId] }),
    foreignKey({
      name: 'staff_inbox_preferences_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('staff_inbox_preferences_volume_ck', sql`${t.soundVolume} between 0 and 100`),
    check(
      'staff_inbox_preferences_availability_ck',
      sql`${t.availability} in ('online', 'away', 'offline')`,
    ),
    tenantIsolation(),
  ],
);

/**
 * How far a staff member has read a conversation: the customer-lane journal position they had
 * seen. The customer messages after it are what the inbox shows as unread. It only moves forward.
 */
export const staffConversationReads = pgTable(
  'staff_conversation_reads',
  {
    tenantId: tenantId(),
    staffMemberId: uuid('staff_member_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    readSeq: bigint('read_seq', { mode: 'number' }).notNull().default(0),
    readAt: tstz('read_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'staff_conversation_reads_pkey',
      columns: [t.tenantId, t.staffMemberId, t.conversationId],
    }),
    index('staff_conversation_reads_conversation_idx').on(t.tenantId, t.conversationId),
    foreignKey({
      name: 'staff_conversation_reads_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'staff_conversation_reads_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }).onDelete('cascade'),
    check('staff_conversation_reads_seq_ck', sql`${t.readSeq} >= 0`),
    tenantIsolation(),
  ],
);
