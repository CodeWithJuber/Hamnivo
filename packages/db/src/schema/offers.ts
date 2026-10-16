import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { teams } from './inbox.js';
import { tenantId } from './tenancy.js';

export const OFFER_STATES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'] as const;
export const OFFER_DECLINE_REASONS = [
  'at_capacity',
  'not_my_area',
  'going_offline',
  'other',
] as const;
export const OFFER_CANCEL_REASONS = [
  'owner_changed',
  'resolved',
  'snoozed',
  'team_changed',
] as const;

/**
 * How one person takes conversations offered to them (HNV-10-03, H02): the languages they answer
 * in (language slices, such as `hi` or `hinglish`) and how many open chats they handle at most.
 * No row: no languages listed and no limit.
 */
export const staffRoutingProfiles = pgTable(
  'staff_routing_profiles',
  {
    tenantId: tenantId(),
    staffMemberId: uuid('staff_member_id').notNull(),
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    /** Null: no limit. */
    maxOpenChats: smallint('max_open_chats'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'staff_routing_profiles_pkey',
      columns: [t.tenantId, t.staffMemberId],
    }),
    foreignKey({
      name: 'staff_routing_profiles_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'staff_routing_profiles_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'staff_routing_profiles_max_ck',
      sql`${t.maxOpenChats} is null or ${t.maxOpenChats} between 1 and 50`,
    ),
    check('staff_routing_profiles_languages_ck', sql`cardinality(${t.languages}) <= 12`),
    tenantIsolation(),
  ],
);

/**
 * A conversation handed to people, offered to one person at a time (HNV-10-03, HNV-10-06): who,
 * for which hand-off (the ownership epoch it was handed over at), which round, until when, and how
 * it ended. An offer is not ownership: the conversation stays in the queue until it is accepted.
 * At most one is pending per conversation. Offers are never deleted by the application; ended ones
 * are removed 90 days later by maintenance.
 */
export const conversationOffers = pgTable(
  'conversation_offers',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    teamId: uuid('team_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    /** The ownership epoch of the hand-off this offer belongs to. */
    handoffEpoch: bigint('handoff_epoch', { mode: 'number' }).notNull(),
    /** 1 for the first person offered for this hand-off, 2 for the next, and so on. */
    round: smallint('round').notNull(),
    state: text('state', { enum: OFFER_STATES }).notNull().default('pending'),
    declineReason: text('decline_reason', { enum: OFFER_DECLINE_REASONS }),
    declineNote: text('decline_note'),
    cancelReason: text('cancel_reason', { enum: OFFER_CANCEL_REASONS }),
    offeredAt: tstz('offered_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    decidedAt: tstz('decided_at'),
    /** The offer's length in seconds when it was made, for reports. */
    timeoutSeconds: integer('timeout_seconds').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversation_offers_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('conversation_offers_pending_key')
      .on(t.tenantId, t.conversationId)
      .where(sql`${t.state} = 'pending'`),
    uniqueIndex('conversation_offers_round_key').on(
      t.tenantId,
      t.conversationId,
      t.handoffEpoch,
      t.round,
    ),
    /** A person's offers: whether they hold one now, and when they were last offered one. */
    index('conversation_offers_staff_idx').on(t.tenantId, t.staffMemberId, t.offeredAt),
    index('conversation_offers_ended_idx').on(t.decidedAt).where(sql`${t.decidedAt} is not null`),
    /** Reports count offers made in a date range. */
    index('conversation_offers_offered_idx').on(t.tenantId, t.offeredAt),
    foreignKey({
      name: 'conversation_offers_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_offers_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    foreignKey({
      name: 'conversation_offers_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('conversation_offers_round_ck', sql`${t.round} between 1 and 10`),
    check(
      'conversation_offers_state_ck',
      sql`(${t.state} = 'pending') = (${t.decidedAt} is null)
        and (${t.state} = 'declined') = (${t.declineReason} is not null)
        and (${t.state} = 'cancelled') = (${t.cancelReason} is not null)
        and (${t.declineNote} is null or char_length(${t.declineNote}) <= 500)
        and ${t.expiresAt} > ${t.offeredAt}`,
    ),
    tenantIsolation(),
  ],
);
