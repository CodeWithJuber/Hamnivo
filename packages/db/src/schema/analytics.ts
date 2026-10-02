import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { tenantIsolation, tstz, updatedAt } from './helpers.js';
import { tenantId } from './tenancy.js';

/**
 * Product analytics projection (O04): one row per conversation with the moments that reports
 * need, kept by triggers on conversation_controls and the customer lane of the journal (see the
 * developer_platform security migration). Timestamps and categories only, never content, so
 * reports outlive the short-lived journal without keeping a second transcript.
 */
export const conversationMetrics = pgTable(
  'conversation_metrics',
  {
    /** The conversation's id. */
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    brandId: uuid('brand_id'),
    inboxId: uuid('inbox_id'),
    /** Channel type of the authority inbox, e.g. `Channel::Api`. */
    channel: text('channel'),
    /** `ai` when the AI assistant held the conversation at first, `people` otherwise. */
    startedWith: text('started_with', { enum: ['ai', 'people'] }).notNull(),
    createdAt: tstz('created_at').notNull(),
    firstCustomerMessageAt: tstz('first_customer_message_at'),
    firstResponseAt: tstz('first_response_at'),
    firstResponseBy: text('first_response_by', { enum: ['ai', 'person'] }),
    firstHumanResponseAt: tstz('first_human_response_at'),
    /** First move from the AI to people, and why (the ownership change reason). */
    handedOffAt: tstz('handed_off_at'),
    handoffReason: text('handoff_reason'),
    /** A person owned or answered the conversation at some point. */
    humanInvolved: boolean('human_involved').notNull().default(false),
    lastResolvedAt: tstz('last_resolved_at'),
    firstResolvedAt: tstz('first_resolved_at'),
    resolvedBy: text('resolved_by', { enum: ['ai', 'person'] }),
    resolutionCount: integer('resolution_count').notNull().default(0),
    reopenCount: integer('reopen_count').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversation_metrics_tenant_id_id_key').on(t.tenantId, t.id),
    index('conversation_metrics_created_idx').on(t.tenantId, t.createdAt),
    foreignKey({
      name: 'conversation_metrics_conversation_fk',
      columns: [t.tenantId, t.id],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }).onDelete('cascade'),
    check(
      'conversation_metrics_counts_ck',
      sql`${t.resolutionCount} >= 0 and ${t.reopenCount} >= 0`,
    ),
    tenantIsolation(),
  ],
);
