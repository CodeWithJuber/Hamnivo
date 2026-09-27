import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/** Language slices that thresholds, routing and evaluations are kept for. */
export const LanguageSlice = z
  .enum(['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'])
  .meta({ id: 'LanguageSlice' });
export type LanguageSlice = z.infer<typeof LanguageSlice>;

/** Decision tasks a brand can configure. Team routing is the first (J02). */
export const DecisionTaskName = z.enum(['team-routing']).meta({ id: 'DecisionTaskName' });
export type DecisionTaskName = z.infer<typeof DecisionTaskName>;

/**
 * A team conversations can be routed to (J02, U07): the intents it handles, the languages its
 * people answer in and the languages it serves through a reviewed translation path.
 */
export const RoutingTeam = z
  .object({
    id: typeId('routingTeam'),
    brandId: typeId('brand'),
    name: z.string(),
    intents: z.array(z.string()),
    languages: z.array(LanguageSlice),
    translationLanguages: z.array(LanguageSlice),
    /** Chatwoot team id; live routing also assigns it there. */
    externalTeamId: z.int().positive().nullable(),
    isDefault: z.boolean(),
    /** Only active teams that are accepting conversations can be routed to. */
    accepting: z.boolean(),
    status: z.enum(['active', 'archived']),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'RoutingTeam' });
export type RoutingTeam = z.infer<typeof RoutingTeam>;

const IntentKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, 'Use lowercase letters, digits, - or _')
  .refine((v) => v !== 'other', '"other" is added automatically');

export const CreateRoutingTeamRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    intents: z.array(IntentKey).max(30).default([]),
    languages: z.array(LanguageSlice).max(6).default([]),
    translationLanguages: z.array(LanguageSlice).max(6).default([]),
    externalTeamId: z.int().positive().nullable().optional(),
    isDefault: z.boolean().default(false),
    accepting: z.boolean().default(true),
  })
  .meta({ id: 'CreateRoutingTeamRequest' });

export const UpdateRoutingTeamRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    intents: z.array(IntentKey).max(30).optional(),
    languages: z.array(LanguageSlice).max(6).optional(),
    translationLanguages: z.array(LanguageSlice).max(6).optional(),
    externalTeamId: z.int().positive().nullable().optional(),
    isDefault: z.boolean().optional(),
    accepting: z.boolean().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .meta({ id: 'UpdateRoutingTeamRequest' });

export const RoutingIntentSchema = z
  .object({
    key: IntentKey,
    /** What the intent covers; the decision provider sees it as the label's description. */
    description: z.string().trim().min(1).max(200),
    /** Words and phrases the deterministic baseline matches, in any language. */
    keywords: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
  })
  .meta({ id: 'RoutingIntent' });

/** A threshold per language slice. A slice without one was not evaluated: the provider abstains. */
export const RubricThreshold = z
  .object({ minConfidence: z.number().min(0).max(1) })
  .meta({ id: 'RubricThreshold' });

/** The questions, inputs and thresholds of a routing rubric (J05, HNV-12-01). */
export const RubricDefinition = z
  .object({
    intents: z.array(RoutingIntentSchema).min(1).max(30),
    /** Only these inputs are shared with the provider; personal data in them is redacted. */
    inputs: z
      .object({
        recentMessages: z.int().min(1).max(5).default(2),
        conversationStatus: z.boolean().default(true),
      })
      .prefault({}),
    thresholds: z.partialRecord(LanguageSlice, RubricThreshold).default({}),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.intents.forEach((intent, index) => {
      if (seen.has(intent.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['intents', index, 'key'],
          message: `"${intent.key}" is listed twice`,
        });
      }
      seen.add(intent.key);
    });
  })
  .meta({ id: 'RubricDefinition' });
export type RubricDefinition = z.output<typeof RubricDefinition>;

export const DecisionProviderKind = z
  .enum(['jev', 'mock', 'none'])
  .meta({ id: 'DecisionProviderKind' });

/** A pinned provider model: it must name a version, never a moving alias such as `latest`. */
export const PinnedModelVersion = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/\d/, 'Name a pinned version, such as jev-1.13.0')
  .refine((v) => !/latest/i.test(v), 'Moving aliases such as "latest" are not allowed');

export const DecisionRubric = z
  .object({
    id: typeId('rubric'),
    brandId: typeId('brand'),
    task: DecisionTaskName,
    version: z.int().positive(),
    state: z.enum(['draft', 'published', 'retired']),
    definition: RubricDefinition,
    provider: DecisionProviderKind,
    modelVersion: z.string().nullable(),
    deadlineMs: z.int(),
    configHash: z.string().nullable(),
    createdAt: Timestamp,
    publishedAt: Timestamp.nullable(),
    publishedBy: typeId('staff').nullable(),
  })
  .meta({ id: 'DecisionRubric' });
export type DecisionRubric = z.infer<typeof DecisionRubric>;

export const SaveRubricDraftRequest = z
  .object({
    definition: RubricDefinition,
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
  .meta({ id: 'SaveRubricDraftRequest' });

export const DecisionMode = z.enum(['off', 'shadow', 'live']).meta({ id: 'DecisionMode' });
export type DecisionMode = z.infer<typeof DecisionMode>;

/** A brand's routing: mode, the published rubric and the draft being edited. */
export const DecisionTask = z
  .object({
    brandId: typeId('brand'),
    task: DecisionTaskName,
    /** shadow: record both decisions and act on neither; live: act on the decision. */
    mode: DecisionMode,
    published: DecisionRubric.nullable(),
    draft: DecisionRubric.nullable(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'DecisionTask' });
export type DecisionTask = z.infer<typeof DecisionTask>;

export const SetDecisionModeRequest = z
  .object({ mode: DecisionMode })
  .meta({ id: 'SetDecisionModeRequest' });

export const DecisionStatus = z.enum(['decided', 'abstained', 'unavailable', 'invalid', 'skipped']);

/**
 * One recorded decision (J07, HNV-12-02 to HNV-12-06): what the provider answered (a confidence
 * only when it gave one), the baseline, the final intent and team, whether it was applied, and
 * the review. It holds labels and versions, never customer text.
 */
export const DecisionRecord = z
  .object({
    id: typeId('decision'),
    brandId: typeId('brand'),
    conversationId: typeId('conversation').nullable(),
    task: DecisionTaskName,
    trigger: z.enum(['new_conversation', 'handoff', 'test']),
    mode: z.enum(['shadow', 'live', 'test']),
    provider: z.string(),
    modelVersion: z.string().nullable(),
    rubricVersion: z.int().nullable(),
    status: DecisionStatus,
    reason: z.string().nullable(),
    retryable: z.boolean().nullable(),
    providerIntent: z.string().nullable(),
    /** The provider's own confidence for its choice; null when it gave none. Never estimated. */
    confidence: z.number().min(0).max(1).nullable(),
    baselineIntent: z.string(),
    finalIntent: z.string(),
    finalSource: z.enum(['provider', 'baseline']),
    fallback: z.string().nullable(),
    team: z.object({ id: typeId('routingTeam'), name: z.string() }).nullable(),
    teamBasis: z.enum(['intent', 'default', 'none']),
    languageMatch: z.enum(['native', 'translation', 'none', 'unknown']),
    language: LanguageSlice.nullable(),
    explicitRequest: z.boolean(),
    applied: z.boolean(),
    latencyMs: z.int().nullable(),
    totalMs: z.int().nullable(),
    inputTokens: z.int().nullable(),
    outputTokens: z.int().nullable(),
    requestId: z.string().nullable(),
    policyVersion: z.string().nullable(),
    offered: z.array(z.string()),
    review: z
      .object({
        intent: z.string(),
        reason: z.string(),
        reviewedBy: typeId('staff').nullable(),
        reviewedAt: Timestamp,
        trainingConsent: z.boolean(),
      })
      .nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'DecisionRecord' });
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const ReviewDecisionRequest = z
  .object({
    /** The intent the reviewer says was right. */
    intent: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1).max(500),
    /** Whether this reviewed label may be used to evaluate future versions. */
    trainingConsent: z.boolean().default(false),
  })
  .meta({ id: 'ReviewDecisionRequest' });

/** A synthetic message to try a rubric with (HNV-12-02). Nothing is sent to a customer. */
export const TestRubricRequest = z
  .object({
    /** Test the draft (default) or the published rubric. */
    rubric: z.enum(['draft', 'published']).default('draft'),
    message: z.string().trim().min(1).max(1000),
  })
  .meta({ id: 'TestRubricRequest' });

export const TestRubricResult = z
  .object({
    record: DecisionRecord,
    /** Rules that take precedence over any provider decision. */
    policy: z.object({
      /** The message asks for a person: the handoff happens at once, whatever the provider says. */
      explicitRequest: z.boolean(),
      /** Input kinds redacted before the provider saw the message, such as `email`. */
      redacted: z.array(z.string()),
    }),
  })
  .meta({ id: 'TestRubricResult' });

const ExperimentSliceSchema = z
  .object({
    records: z.int(),
    decided: z.int(),
    abstained: z.int(),
    unavailable: z.int(),
    invalid: z.int(),
    agreement: z.number().nullable(),
    reviewed: z.int(),
    providerAccuracy: z.number().nullable(),
    baselineAccuracy: z.number().nullable(),
    latencyP50Ms: z.number().nullable(),
    latencyP95Ms: z.number().nullable(),
    inputTokens: z.int(),
    outputTokens: z.int(),
  })
  .meta({ id: 'ExperimentSlice' });

/** Provider versus baseline over recorded decisions (J08). */
export const ExperimentReport = z
  .object({
    brandId: typeId('brand'),
    task: DecisionTaskName,
    since: Timestamp,
    overall: ExperimentSliceSchema,
    byLanguage: z.record(z.string(), ExperimentSliceSchema),
  })
  .meta({ id: 'ExperimentReport' });
export type ExperimentReport = z.infer<typeof ExperimentReport>;
