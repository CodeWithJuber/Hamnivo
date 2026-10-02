import { z } from 'zod';
import { Timestamp } from './common.js';
import {
  DecisionMode,
  DecisionProviderKind,
  DecisionStatus,
  JevStatus,
  LanguageSlice,
  PinnedModelVersion,
} from './decisions.js';
import { typeId } from './ids.js';

/**
 * Checks Jev runs around an AI reply. `answer-check`: before an AI reply is published, each
 * sentence that cites a knowledge passage is checked against that passage. `escalation`: whether
 * the customer's messages need a person (J04); it can only add a hand-off.
 */
export const CheckTaskName = z.enum(['answer-check', 'escalation']).meta({ id: 'CheckTaskName' });
export type CheckTaskName = z.infer<typeof CheckTaskName>;

/**
 * A threshold for one question kind in one language. A choice answer is used at or above
 * `minConfidence`; a yes-or-no (noul) answer counts as yes at or above `trueAtLeast` and as no at
 * or below `falseAtMost`, and in between it is not used.
 */
export const CheckThreshold = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('choice'), minConfidence: z.number().min(0).max(1) }),
    z.object({
      type: z.literal('noul'),
      trueAtLeast: z.number().min(0).max(1),
      falseAtMost: z.number().min(0).max(1),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'noul' && value.falseAtMost > value.trueAtLeast) {
      ctx.addIssue({
        code: 'custom',
        path: ['falseAtMost'],
        message: 'The "no" bound must not be above the "yes" bound',
      });
    }
  })
  .meta({ id: 'CheckThreshold' });
export type CheckThreshold = z.infer<typeof CheckThreshold>;

/** Thresholds by language slice, then question kind. A language without them is not evaluated. */
export const CheckThresholds = z
  .partialRecord(LanguageSlice, z.record(z.string(), CheckThreshold))
  .meta({ id: 'CheckThresholds' });
export type CheckThresholds = z.infer<typeof CheckThresholds>;

/** A question Jev is asked, shown so staff can see exactly what is asked. */
export const CheckQuestion = z
  .object({
    /** The threshold key it uses. */
    key: z.string(),
    type: z.enum(['choice', 'noul']),
    instructions: z.string(),
    /** Choice labels, or the yes and no outcomes of a noul, with their descriptions. */
    options: z.record(z.string(), z.string().nullable()),
  })
  .meta({ id: 'CheckQuestion' });
export type CheckQuestion = z.infer<typeof CheckQuestion>;

export const CheckRubric = z
  .object({
    id: typeId('rubric'),
    brandId: typeId('brand'),
    task: CheckTaskName,
    version: z.int().positive(),
    state: z.enum(['draft', 'published', 'retired']),
    thresholds: CheckThresholds,
    provider: DecisionProviderKind,
    modelVersion: z.string().nullable(),
    deadlineMs: z.int(),
    configHash: z.string().nullable(),
    createdAt: Timestamp,
    publishedAt: Timestamp.nullable(),
    publishedBy: typeId('staff').nullable(),
  })
  .meta({ id: 'CheckRubric' });
export type CheckRubric = z.infer<typeof CheckRubric>;

/** A brand's check: its mode, published rubric and draft, and what it asks. */
export const CheckTask = z
  .object({
    brandId: typeId('brand'),
    task: CheckTaskName,
    /** shadow: record what the check finds and act on nothing; live: act on it. */
    mode: DecisionMode,
    published: CheckRubric.nullable(),
    draft: CheckRubric.nullable(),
    updatedAt: Timestamp.nullable(),
    questions: z.array(CheckQuestion),
    /**
     * Thresholds measured live for `jev.recommendedModel` (docs/evals); empty where none were.
     * Studio fills empty languages with them when a rubric chooses that version.
     */
    recommendedThresholds: CheckThresholds,
    jev: JevStatus,
  })
  .meta({ id: 'CheckTask' });
export type CheckTask = z.infer<typeof CheckTask>;

export const SaveCheckDraftRequest = z
  .object({
    thresholds: CheckThresholds.default({}),
    provider: DecisionProviderKind.default('none'),
    modelVersion: PinnedModelVersion.nullable().optional(),
    /** Total deadline of one provider call. The chat path uses 1.5 s. */
    deadlineMs: z.int().min(100).max(10_000).default(1500),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'jev' && !value.modelVersion) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelVersion'],
        message: 'Jev needs a pinned model version',
      });
    }
  })
  .meta({ id: 'SaveCheckDraftRequest' });

/**
 * One check and what came of it: labels and numbers per question, what code concluded and what
 * Hamnivo did (only in live mode). It never holds customer or reply text.
 */
export const CheckRecord = z
  .object({
    id: typeId('check'),
    brandId: typeId('brand'),
    conversationId: typeId('conversation').nullable(),
    runId: typeId('run').nullable(),
    task: CheckTaskName,
    mode: z.enum(['shadow', 'live', 'test']),
    provider: z.string(),
    modelVersion: z.string().nullable(),
    rubricVersion: z.int().nullable(),
    status: DecisionStatus,
    reason: z.string().nullable(),
    retryable: z.boolean().nullable(),
    language: LanguageSlice.nullable(),
    /** What code concluded, such as `pass`, `fail` or `unsure`. */
    verdict: z.string(),
    /** What Hamnivo did or would have done, such as `publish`, `regenerate` or `handoff`. */
    action: z.string(),
    /** The action was taken (live mode). */
    applied: z.boolean(),
    answers: z.record(z.string(), z.record(z.string(), z.unknown())),
    detail: z.record(z.string(), z.unknown()),
    latencyMs: z.int().nullable(),
    totalMs: z.int().nullable(),
    inputTokens: z.int().nullable(),
    outputTokens: z.int().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'CheckRecord' });
export type CheckRecord = z.infer<typeof CheckRecord>;
