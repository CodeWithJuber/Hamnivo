import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { brands, tenantId } from './tenancy.js';

/**
 * A routing destination of a brand (J02, U07): the intents it handles, the languages its people
 * answer in, the languages it serves through a reviewed translation path, and its Chatwoot team
 * when one is linked. Only active teams that are accepting conversations can be routed to.
 */
export const routingTeams = pgTable(
  'routing_teams',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    intents: text('intents').array().notNull().default(sql`'{}'::text[]`),
    /** Language slices (en, ar, hi, ur, hinglish, roman-urdu). */
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    translationLanguages: text('translation_languages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Chatwoot team id in the brand's account; live routing assigns it there too. */
    externalTeamId: integer('external_team_id'),
    isDefault: boolean('is_default').notNull().default(false),
    accepting: boolean('accepting').notNull().default(true),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('routing_teams_tenant_id_id_key').on(t.tenantId, t.id),
    unique('routing_teams_name_key').on(t.tenantId, t.brandId, t.name),
    foreignKey({
      name: 'routing_teams_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'routing_teams_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const DECISION_PROVIDERS = ['jev', 'mock', 'none'] as const;

/**
 * Versioned questions and thresholds for one decision task of a brand (J05): intents with their
 * descriptions and baseline keywords, the inputs shared with the provider, per-language
 * thresholds, the pinned provider model and the deadline. A published version never changes; a
 * database trigger enforces it, so a decision record always says what it was judged by.
 */
export const decisionRubrics = pgTable(
  'decision_rubrics',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    task: text('task').notNull(),
    version: integer('version').notNull(),
    state: text('state', { enum: ['draft', 'published', 'retired'] })
      .notNull()
      .default('draft'),
    definition: jsonb('definition').notNull(),
    provider: text('provider', { enum: DECISION_PROVIDERS }).notNull().default('none'),
    /** A pinned provider model such as `jev-1.13.0`; moving aliases are refused. */
    modelVersion: text('model_version'),
    deadlineMs: integer('deadline_ms').notNull().default(1500),
    /** SHA-256 of the canonical definition, fixed when published. */
    configHash: bytea('config_hash'),
    createdBy: uuid('created_by'),
    publishedBy: uuid('published_by'),
    publishedAt: tstz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('decision_rubrics_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('decision_rubrics_version_key').on(t.tenantId, t.brandId, t.task, t.version),
    uniqueIndex('decision_rubrics_one_draft_key')
      .on(t.tenantId, t.brandId, t.task)
      .where(sql`${t.state} = 'draft'`),
    uniqueIndex('decision_rubrics_one_published_key')
      .on(t.tenantId, t.brandId, t.task)
      .where(sql`${t.state} = 'published'`),
    foreignKey({
      name: 'decision_rubrics_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'decision_rubrics_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'decision_rubrics_published_by_fk',
      columns: [t.tenantId, t.publishedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check('decision_rubrics_version_ck', sql`${t.version} > 0`),
    check('decision_rubrics_deadline_ck', sql`${t.deadlineMs} between 100 and 10000`),
    check(
      'decision_rubrics_published_ck',
      sql`${t.state} = 'draft' or (${t.configHash} is not null and ${t.publishedAt} is not null)`,
    ),
    tenantIsolation(),
  ],
);

export const DECISION_MODES = ['off', 'shadow', 'live'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

/**
 * How a brand uses a decision task: `shadow` records the provider's decision next to the
 * baseline's without acting on either; `live` applies the provider's decision, or the baseline's
 * when the provider cannot decide; `off` records nothing.
 */
export const decisionTasks = pgTable(
  'decision_tasks',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    task: text('task').notNull(),
    mode: text('mode', { enum: DECISION_MODES }).notNull().default('shadow'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('decision_tasks_tenant_id_id_key').on(t.tenantId, t.id),
    unique('decision_tasks_task_key').on(t.tenantId, t.brandId, t.task),
    foreignKey({
      name: 'decision_tasks_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'decision_tasks_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const DECISION_STATUSES = [
  'decided',
  'abstained',
  'unavailable',
  'invalid',
  'skipped',
] as const;

/**
 * One decision and what came of it (J07): the provider result (never an invented confidence:
 * null when the provider gave none), the baseline, the final choice and whether it was applied,
 * with rubric and model versions, latency and tokens. It holds hashes and labels, never customer
 * text. Rows are append-only except for applying and reviewing (a trigger enforces it).
 */
export const decisionRecords = pgTable(
  'decision_records',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    conversationId: uuid('conversation_id'),
    task: text('task').notNull(),
    trigger: text('trigger', { enum: ['new_conversation', 'handoff', 'test'] }).notNull(),
    /** Idempotency within a conversation, e.g. `new:{ledgerId}` or `handoff:{epoch}`. */
    triggerRef: text('trigger_ref').notNull(),
    rubricId: uuid('rubric_id'),
    rubricVersion: integer('rubric_version'),
    mode: text('mode', { enum: ['shadow', 'live', 'test'] }).notNull(),
    provider: text('provider').notNull(),
    modelVersion: text('model_version'),
    status: text('status', { enum: DECISION_STATUSES }).notNull(),
    /** Provider or skip reason: a code or rule text, never customer text. */
    reason: text('reason'),
    retryable: boolean('retryable'),
    providerIntent: text('provider_intent'),
    /** The provider's confidence for choice answers; null when it gave none. */
    confidence: real('confidence'),
    probabilities: jsonb('probabilities'),
    baselineIntent: text('baseline_intent').notNull(),
    baselineMatches: jsonb('baseline_matches').notNull().default({}),
    finalIntent: text('final_intent').notNull(),
    finalSource: text('final_source', { enum: ['provider', 'baseline'] }).notNull(),
    fallback: text('fallback'),
    teamId: uuid('team_id'),
    teamBasis: text('team_basis', { enum: ['intent', 'default', 'none'] }).notNull(),
    languageMatch: text('language_match', {
      enum: ['native', 'translation', 'none', 'unknown'],
    }).notNull(),
    /** Language slice of the customer's messages. */
    language: text('language'),
    explicitRequest: boolean('explicit_request').notNull().default(false),
    applied: boolean('applied').notNull().default(false),
    appliedAt: tstz('applied_at'),
    /** Provider call time, including failures and timeouts. */
    latencyMs: integer('latency_ms'),
    /** The whole decision, from loading the conversation to recording it. */
    totalMs: integer('total_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requestId: text('request_id'),
    policyVersion: text('policy_version'),
    /** SHA-256 of the minimized state sent to the provider. */
    stateHash: bytea('state_hash'),
    offered: text('offered').array().notNull().default(sql`'{}'::text[]`),
    reviewedIntent: text('reviewed_intent'),
    reviewReason: text('review_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: tstz('reviewed_at'),
    /** A reviewed label may be used to evaluate future versions only with this consent. */
    trainingConsent: boolean('training_consent').notNull().default(false),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('decision_records_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('decision_records_trigger_key')
      .on(t.tenantId, t.conversationId, t.task, t.triggerRef)
      .where(sql`${t.conversationId} is not null`),
    index('decision_records_brand_idx').on(t.tenantId, t.brandId, t.task, t.createdAt),
    foreignKey({
      name: 'decision_records_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'decision_records_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'decision_records_rubric_fk',
      columns: [t.tenantId, t.rubricId],
      foreignColumns: [decisionRubrics.tenantId, decisionRubrics.id],
    }),
    foreignKey({
      name: 'decision_records_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [routingTeams.tenantId, routingTeams.id],
    }),
    foreignKey({
      name: 'decision_records_reviewed_by_fk',
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'decision_records_confidence_ck',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * The team a conversation is routed to now, by live routing or by a person. Chatwoot gets the
 * team through the outbox when the team is linked to one.
 */
export const conversationRoutes = pgTable(
  'conversation_routes',
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    teamId: uuid('team_id').notNull(),
    decisionId: uuid('decision_id'),
    source: text('source', { enum: ['provider', 'baseline', 'manual'] }).notNull(),
    syncState: text('sync_state', { enum: ['pending', 'synced', 'not_linked', 'failed'] })
      .notNull()
      .default('pending'),
    routedAt: tstz('routed_at').notNull().defaultNow(),
    syncedAt: tstz('synced_at'),
  },
  (t) => [
    unique('conversation_routes_tenant_id_id_key').on(t.tenantId, t.id),
    unique('conversation_routes_conversation_key').on(t.tenantId, t.conversationId),
    index('conversation_routes_team_idx').on(t.tenantId, t.teamId),
    foreignKey({
      name: 'conversation_routes_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'conversation_routes_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'conversation_routes_team_fk',
      columns: [t.tenantId, t.teamId],
      foreignColumns: [routingTeams.tenantId, routingTeams.id],
    }),
    foreignKey({
      name: 'conversation_routes_decision_fk',
      columns: [t.tenantId, t.decisionId],
      foreignColumns: [decisionRecords.tenantId, decisionRecords.id],
    }),
    tenantIsolation(),
  ],
);
