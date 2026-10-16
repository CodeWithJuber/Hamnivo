import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls, messageLedger } from './authority.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { agentProfiles, agentVersions, runs } from './runtime.js';
import { tenantId } from './tenancy.js';

export const AI_DRAFT_STATES = ['pending', 'approved', 'edited', 'rejected', 'superseded'] as const;
export const AI_DRAFT_SUPERSEDED_REASONS = [
  'customer_wrote',
  'owner_changed',
  'answered',
  'replaced',
  'resolved',
] as const;
export const AI_DRAFT_DECISIONS = ['approved', 'edited', 'rejected'] as const;
export const AI_DRAFT_REJECT_REASONS = [
  'inaccurate',
  'incomplete',
  'wrong_tone',
  'not_needed',
  'other',
] as const;

/** A public source a draft cites (the `SourcePart` contract). */
export interface AiDraftSourceJson {
  type: 'source';
  sourceId: string;
  title: string;
  url: string | null;
  version: string | null;
  excerpt: string | null;
  freshness: 'current' | 'stale' | 'expired';
}

/**
 * A reply an assist-mode agent wrote for people to review (HNV-09-05, G03): never sent on its own.
 * At most one is pending per conversation. What it says, cites and answers never changes; only its
 * state moves on, once, when a person approves, edits or rejects it, or when it goes stale (the
 * customer wrote again, the owner changed, a person answered by hand, it was replaced, resolved).
 * The run that wrote it keeps no text (X11); this row does, and is removed 90 days after it ended.
 */
export const aiDrafts = pgTable(
  'ai_drafts',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    runId: uuid('run_id').notNull(),
    agentId: uuid('agent_id'),
    agentVersionId: uuid('agent_version_id'),
    /** The customer message it answers. */
    triggerLedgerId: uuid('trigger_ledger_id').notNull(),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull(),
    text: text('text').notNull(),
    sources: jsonb('sources').$type<AiDraftSourceJson[]>().notNull().default([]),
    language: text('language'),
    state: text('state', { enum: AI_DRAFT_STATES }).notNull().default('pending'),
    supersededReason: text('superseded_reason', { enum: AI_DRAFT_SUPERSEDED_REASONS }),
    /** Who approved, edited or rejected it; null when it went stale. */
    decidedBy: uuid('decided_by'),
    /** When it stopped being pending, whatever ended it. */
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('ai_drafts_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('ai_drafts_run_key').on(t.tenantId, t.runId),
    uniqueIndex('ai_drafts_pending_key')
      .on(t.tenantId, t.conversationId)
      .where(sql`${t.state} = 'pending'`),
    index('ai_drafts_conversation_idx').on(t.tenantId, t.conversationId, t.createdAt),
    index('ai_drafts_ended_idx').on(t.decidedAt).where(sql`${t.decidedAt} is not null`),
    /** Reports count drafts written in a date range. */
    index('ai_drafts_created_idx').on(t.tenantId, t.createdAt),
    foreignKey({
      name: 'ai_drafts_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'ai_drafts_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'ai_drafts_agent_fk',
      columns: [t.tenantId, t.agentId],
      foreignColumns: [agentProfiles.tenantId, agentProfiles.id],
    }),
    foreignKey({
      name: 'ai_drafts_agent_version_fk',
      columns: [t.tenantId, t.agentVersionId],
      foreignColumns: [agentVersions.tenantId, agentVersions.id],
    }),
    foreignKey({
      name: 'ai_drafts_trigger_fk',
      columns: [t.tenantId, t.triggerLedgerId],
      foreignColumns: [messageLedger.tenantId, messageLedger.id],
    }),
    foreignKey({
      name: 'ai_drafts_decided_by_fk',
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('ai_drafts_text_ck', sql`char_length(${t.text}) between 1 and 10000`),
    check('ai_drafts_sources_ck', sql`jsonb_typeof(${t.sources}) = 'array'`),
    check(
      'ai_drafts_state_ck',
      sql`(${t.state} = 'superseded') = (${t.supersededReason} is not null)
        and (${t.state} in ('approved', 'edited', 'rejected')) = (${t.decidedBy} is not null)
        and (${t.state} = 'pending') = (${t.decidedAt} is null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * What a person decided on a draft: exactly once per draft, with the request that decided it (a
 * retry replays it), the hash of the text they sent when they edited it, and why they rejected it.
 * Append-only: the application role can insert but never change or delete a decision.
 */
export const aiDraftDecisions = pgTable(
  'ai_draft_decisions',
  {
    id: id(),
    tenantId: tenantId(),
    draftId: uuid('draft_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    clientRequestId: uuid('client_request_id').notNull(),
    decision: text('decision', { enum: AI_DRAFT_DECISIONS }).notNull(),
    /** sha256 of the text sent, when it was edited. */
    textHash: bytea('text_hash'),
    ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull(),
    reason: text('reason', { enum: AI_DRAFT_REJECT_REASONS }),
    note: text('note'),
    /** The message an approval sent (its `clientMessageId`). */
    clientMessageId: uuid('client_message_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ai_draft_decisions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('ai_draft_decisions_draft_key').on(t.tenantId, t.draftId),
    uniqueIndex('ai_draft_decisions_request_key').on(t.tenantId, t.clientRequestId),
    foreignKey({
      name: 'ai_draft_decisions_draft_fk',
      columns: [t.tenantId, t.draftId],
      foreignColumns: [aiDrafts.tenantId, aiDrafts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ai_draft_decisions_staff_fk',
      columns: [t.tenantId, t.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'ai_draft_decisions_shape_ck',
      sql`(${t.decision} = 'edited') = (${t.textHash} is not null)
        and (${t.decision} = 'rejected') = (${t.reason} is not null)
        and (${t.decision} = 'rejected') = (${t.clientMessageId} is null)
        and (${t.textHash} is null or octet_length(${t.textHash}) = 32)
        and (${t.note} is null or char_length(${t.note}) <= 500)`,
    ),
    tenantIsolation(),
  ],
);
