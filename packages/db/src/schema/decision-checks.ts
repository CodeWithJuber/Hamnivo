import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversationControls } from './authority.js';
import { DECISION_STATUSES, decisionRubrics } from './decisions.js';
import { bytea, createdAt, id, tenantIsolation } from './helpers.js';
import { runs } from './runtime.js';
import { brands, tenantId } from './tenancy.js';

/**
 * Checks a decision provider (Jev) runs around an AI reply: the answer check (citations against
 * their passages), escalation advice (J04), passage relevance (J03), the reply language (U01)
 * and the message guard. Their rubrics and modes are `decision_rubrics` and `decision_tasks`
 * rows under these task names.
 */
export const DECISION_CHECK_TASKS = [
  'answer-check',
  'escalation',
  'passage-relevance',
  'language',
  'message-guard',
] as const;

/**
 * One check and what came of it: the provider's answers after thresholds (labels and numbers),
 * what code concluded (`verdict`), what Hamnivo did (`action`, `applied` only in live mode), with
 * rubric and model versions, latency and tokens. It holds labels, numbers, hashes and public ids,
 * never customer or reply text. Rows are written once and never changed or deleted.
 */
export const decisionChecks = pgTable(
  'decision_checks',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: uuid('brand_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** The AI run the check belongs to, when there is one. */
    runId: uuid('run_id'),
    task: text('task', { enum: DECISION_CHECK_TASKS }).notNull(),
    /** Idempotency per task, e.g. `run:{runId}:answer:1`. */
    triggerRef: text('trigger_ref').notNull(),
    rubricId: uuid('rubric_id'),
    rubricVersion: integer('rubric_version'),
    mode: text('mode', { enum: ['shadow', 'live', 'test'] }).notNull(),
    provider: text('provider').notNull(),
    modelVersion: text('model_version'),
    status: text('status', { enum: DECISION_STATUSES }).notNull(),
    /** Provider, threshold or skip reason: a code or rule text, never customer text. */
    reason: text('reason'),
    retryable: boolean('retryable'),
    /** Language slice whose thresholds applied. */
    language: text('language'),
    /** What code concluded from the answers, such as `pass`, `fail` or `handoff`. */
    verdict: text('verdict').notNull(),
    /** What Hamnivo did or would do because of it, such as `publish` or `regenerate`. */
    action: text('action').notNull(),
    /** The action was taken (live mode); shadow records only. */
    applied: boolean('applied').notNull().default(false),
    /** Per question: label or probability, confidence, and whether its threshold kept it. */
    answers: jsonb('answers').notNull().default({}),
    /** Task facts such as sentence positions or passage document ids; never text. */
    detail: jsonb('detail').notNull().default({}),
    /** Provider call time, including failures and timeouts. */
    latencyMs: integer('latency_ms'),
    /** The whole check, from building its state to recording it. */
    totalMs: integer('total_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requestId: text('request_id'),
    policyVersion: text('policy_version'),
    /** SHA-256 of the minimized state sent to the provider. */
    stateHash: bytea('state_hash'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('decision_checks_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('decision_checks_trigger_key').on(t.tenantId, t.task, t.triggerRef),
    index('decision_checks_brand_idx').on(t.tenantId, t.brandId, t.task, t.createdAt),
    index('decision_checks_conversation_idx').on(t.tenantId, t.conversationId, t.createdAt),
    foreignKey({
      name: 'decision_checks_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'decision_checks_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversationControls.tenantId, conversationControls.id],
    }),
    foreignKey({
      name: 'decision_checks_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }),
    foreignKey({
      name: 'decision_checks_rubric_fk',
      columns: [t.tenantId, t.rubricId],
      foreignColumns: [decisionRubrics.tenantId, decisionRubrics.id],
    }),
    tenantIsolation(),
  ],
);
