import { sql } from 'drizzle-orm';
import {
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
import { authorityConnections, conversationControls } from './authority.js';
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { tenantId, workspaces } from './tenancy.js';

/**
 * The staff inbox (H01–H17). Conversations, messages, notes, assignment, labels and saved replies
 * stay in the conversation authority; these tables hold what Hamnivo owns around them: teams,
 * a small projection for queue filters, staff drafts, links between cases and quality reviews.
 */

/** A group of staff that conversations can be assigned to; also a grant scope (`team`). */
export const teams = pgTable(
  'teams',
  {
    id: id(),
    tenantId: tenantId(),
    /** Null: the team works across the tenant. */
    workspaceId: uuid('workspace_id'),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('teams_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('teams_name_key').on(t.tenantId, sql`lower(${t.name})`),
    foreignKey({
      name: 'teams_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'teams_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const teamMembers = pgTable(
  'team_members',
  {
    tenantId: tenantId(),
    teamId: uuid('team_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'team_members_pkey', columns: [t.tenantId, t.teamId, t.staffMemberId] }),
    index('team_members_staff_idx').on(t.tenantId, t.staffMemberId),
    foreignKey({
      name: 'team_members_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    foreignKey({
      name: 'team_members_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/** The Chatwoot team behind a Hamnivo team in one connected account (created on first use). */
export const teamAuthorityLinks = pgTable(
  'team_authority_links',
  {
    tenantId: tenantId(),
    teamId: uuid('team_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalTeamId: integer('external_team_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'team_authority_links_pkey',
      columns: [t.tenantId, t.teamId, t.connectionId],
    }),
    uniqueIndex('team_authority_links_external_key').on(
      t.tenantId,
      t.connectionId,
      t.externalTeamId,
    ),
    foreignKey({
      name: 'team_authority_links_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    foreignKey({
      name: 'team_authority_links_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [authorityConnections.tenantId, authorityConnections.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * Queue metadata for one conversation: its team, and a projection of the authority's labels and
 * snooze time so queues can be filtered without asking Chatwoot. Written when staff change them
 * through Hamnivo and when Chatwoot reports a newer conversation state.
 */
export const conversationInboxState = pgTable(
  'conversation_inbox_state',
  {
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    teamId: uuid('team_id'),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    snoozedUntil: tstz('snoozed_until'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'conversation_inbox_state_pkey',
      columns: [t.tenantId, t.conversationId],
    }),
    index('conversation_inbox_state_team_idx').on(t.tenantId, t.teamId),
    index('conversation_inbox_state_labels_idx').using('gin', t.labels),
    foreignKey({
      name: 'conversation_inbox_state_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_inbox_state_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    tenantIsolation(),
  ],
);

export const DRAFT_LANES = ['public', 'internal'] as const;

/**
 * A staff member's unsent text (H09), per conversation and lane, so a private note never turns
 * into a public reply by switching modes. `outgoing` rows are sends not yet confirmed by the
 * authority: they keep the text and the client message id, so a retry is deduplicated.
 */
export const staffDrafts = pgTable(
  'staff_drafts',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    lane: text('lane', { enum: DRAFT_LANES }).notNull(),
    kind: text('kind', { enum: ['draft', 'outgoing'] }).notNull(),
    text: text('text').notNull(),
    revision: integer('revision').notNull().default(1),
    clientMessageId: uuid('client_message_id'),
    state: text('state', { enum: ['editing', 'sending', 'failed'] })
      .notNull()
      .default('editing'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('staff_drafts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('staff_drafts_lane_key')
      .on(t.tenantId, t.conversationId, t.staffMemberId, t.lane)
      .where(sql`${t.kind} = 'draft'`),
    uniqueIndex('staff_drafts_outgoing_key')
      .on(t.tenantId, t.conversationId, t.staffMemberId, t.clientMessageId)
      .where(sql`${t.kind} = 'outgoing'`),
    foreignKey({
      name: 'staff_drafts_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'staff_drafts_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('staff_drafts_lane_ck', sql`${t.lane} in ('public', 'internal')`),
    check(
      'staff_drafts_kind_ck',
      sql`(${t.kind} = 'draft' and ${t.clientMessageId} is null) or (${t.kind} = 'outgoing' and ${t.clientMessageId} is not null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * Two conversations about the same case (H17). Transcripts are never merged: each stays in the
 * authority as it is. Stored once per pair, smaller id first.
 */
export const conversationLinks = pgTable(
  'conversation_links',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    linkedConversationId: uuid('linked_conversation_id').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('conversation_links_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('conversation_links_pair_key').on(
      t.tenantId,
      t.conversationId,
      t.linkedConversationId,
    ),
    index('conversation_links_linked_idx').on(t.tenantId, t.linkedConversationId),
    foreignKey({
      name: 'conversation_links_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_links_linked_fk',
      columns: [t.tenantId, t.linkedConversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_links_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('conversation_links_order_ck', sql`${t.conversationId} < ${t.linkedConversationId}`),
    tenantIsolation(),
  ],
);

/** A supervisor's quality review of a conversation, with coaching notes (H14). */
export const conversationReviews = pgTable(
  'conversation_reviews',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    reviewerId: uuid('reviewer_id').notNull(),
    subjectStaffId: uuid('subject_staff_id'),
    rating: smallint('rating').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('conversation_reviews_tenant_id_id_key').on(t.tenantId, t.id),
    index('conversation_reviews_conversation_idx').on(t.tenantId, t.conversationId),
    foreignKey({
      name: 'conversation_reviews_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_reviews_reviewer_fk',
      columns: [t.tenantId, t.reviewerId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'conversation_reviews_subject_fk',
      columns: [t.tenantId, t.subjectStaffId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('conversation_reviews_rating_ck', sql`${t.rating} between 1 and 5`),
    tenantIsolation(),
  ],
);
