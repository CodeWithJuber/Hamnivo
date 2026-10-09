import { sql } from 'drizzle-orm';
import {
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
import { createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * Automations (G21): a brand's "When … If … Then …" rules. The editor saves a draft; publishing
 * keeps the definition as an immutable version, and only the published version runs. Chat rules
 * record each run, at most once per conversation and event, which is also what stops a rule from
 * running twice.
 */

export const AUTOMATION_KINDS = ['visitor', 'conversation'] as const;
export const AUTOMATION_RUN_OUTCOMES = ['done', 'skipped'] as const;

export const automations = pgTable(
  'automations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: AUTOMATION_KINDS }).notNull(),
    /** Off keeps the rule without running it. */
    enabled: boolean('enabled').notNull().default(true),
    /** AutomationDefinition, validated by its contract before it is stored. */
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    /** Goes up with each saved draft, so a stale editor cannot overwrite or publish blindly. */
    revision: integer('revision').notNull().default(1),
    /** The version that runs; null until first published. */
    publishedVersionId: uuid('published_version_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('automations_tenant_id_id_key').on(t.tenantId, t.id),
    index('automations_brand_idx').on(t.tenantId, t.brandId, t.kind),
    check('automations_kind_ck', sql`${t.kind} in ('visitor', 'conversation')`),
    check('automations_revision_ck', sql`${t.revision} > 0`),
    check('automations_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    foreignKey({
      name: 'automations_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'automations_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/** A published definition. Never changed; removed only with its rule. */
export const automationVersions = pgTable(
  'automation_versions',
  {
    id: id(),
    tenantId: tenantId(),
    automationId: uuid('automation_id').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    /** Null when Hamnivo published it (the old proactive prompts, moved into rules). */
    publishedBy: uuid('published_by'),
    publishedAt: tstz('published_at').notNull().defaultNow(),
  },
  (t) => [
    unique('automation_versions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('automation_versions_version_key').on(t.tenantId, t.automationId, t.version),
    check('automation_versions_version_ck', sql`${t.version} > 0`),
    foreignKey({
      name: 'automation_versions_automation_fk',
      columns: [t.tenantId, t.automationId],
      foreignColumns: [automations.tenantId, automations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'automation_versions_published_by_fk',
      columns: [t.tenantId, t.publishedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * What a chat rule did in a conversation. `event_key` is the event's name for a run that acted, so
 * a rule acts at most once per conversation and event; a run that was held back (`skipped`) keys
 * on its source as well, so it never blocks a later run.
 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    automationId: uuid('automation_id').notNull(),
    versionId: uuid('version_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    event: text('event').notNull(),
    eventKey: text('event_key').notNull(),
    outcome: text('outcome', { enum: AUTOMATION_RUN_OUTCOMES }).notNull(),
    /** Why it was held back, or which actions were left out (`message_limit`). */
    reason: text('reason'),
    /** The actions that ran, by type. */
    actions: text('actions').array().notNull().default(sql`'{}'::text[]`),
    ranAt: tstz('ran_at').notNull().defaultNow(),
  },
  (t) => [
    unique('automation_runs_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('automation_runs_once_key').on(
      t.tenantId,
      t.automationId,
      t.conversationId,
      t.eventKey,
    ),
    index('automation_runs_recent_idx').on(t.tenantId, t.automationId, t.ranAt),
    index('automation_runs_conversation_idx').on(t.tenantId, t.conversationId, t.ranAt),
    index('automation_runs_expiry_idx').on(t.ranAt),
    check('automation_runs_outcome_ck', sql`${t.outcome} in ('done', 'skipped')`),
    foreignKey({
      name: 'automation_runs_automation_fk',
      columns: [t.tenantId, t.automationId],
      foreignColumns: [automations.tenantId, automations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'automation_runs_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [automationVersions.tenantId, automationVersions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'automation_runs_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);
