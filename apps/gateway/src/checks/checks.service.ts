import { createHash } from 'node:crypto';
import { type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import {
  answersRecord,
  CHECK_TASKS,
  type CheckTask,
  type CheckThresholds,
  type DecisionAnswers,
  type DecisionQuestions,
  type DecisionResult,
  type DecisionState,
  type GatedAnswers,
  gateCheck,
  isCheckTask,
  type LanguageSlice,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq, inArray } from 'drizzle-orm';
import { DecisionProviders, MOCK_MODEL_VERSION } from '../decisions/providers.js';
import { APP_DB } from '../tokens.js';

export type RubricRow = typeof schema.decisionRubrics.$inferSelect;
export type CheckRow = typeof schema.decisionChecks.$inferSelect;
type CheckInsert = typeof schema.decisionChecks.$inferInsert;

/** The stored definition of a check rubric: thresholds by language slice, then question kind. */
export interface CheckDefinition {
  thresholds: CheckThresholds;
}

export const checkDefinitionOf = (row: RubricRow): CheckDefinition => {
  const definition = (row.definition ?? {}) as Partial<CheckDefinition>;
  return { thresholds: definition.thresholds ?? {} };
};

/** A check that runs for a brand: shadow or live, with its published rubric. */
export interface CheckSetting {
  task: CheckTask;
  mode: 'shadow' | 'live';
  rubric: RubricRow;
}

/** One question set asked, with each answer held to its threshold. */
export interface Asked {
  setting: CheckSetting;
  result: DecisionResult<DecisionAnswers>;
  gated: GatedAnswers;
  language: LanguageSlice | null;
  stateHash: Buffer;
  totalMs: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const rubricVersionOf = (row: RubricRow) => `${row.task}-v${row.version}`;

/**
 * Runs checks with the decision machinery (J01, J06, J07): the brand's published rubric names the
 * provider, the pinned model, the deadline and the thresholds per language; the provider's
 * breaker and deadline apply; each check is recorded with what was answered and done. A provider
 * that cannot answer is a result, never an error: callers then behave as they do without the
 * check.
 */
@Injectable()
export class ChecksService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly providers: DecisionProviders,
  ) {}

  /** Checks that run for a brand: mode shadow or live, with a published rubric and a provider. */
  async settings(tx: TenantTx, brandId: string): Promise<Map<CheckTask, CheckSetting>> {
    const tasks = [...CHECK_TASKS];
    const modes = await tx
      .select()
      .from(schema.decisionTasks)
      .where(
        and(eq(schema.decisionTasks.brandId, brandId), inArray(schema.decisionTasks.task, tasks)),
      );
    const rubrics = await tx
      .select()
      .from(schema.decisionRubrics)
      .where(
        and(
          eq(schema.decisionRubrics.brandId, brandId),
          inArray(schema.decisionRubrics.task, tasks),
          eq(schema.decisionRubrics.state, 'published'),
        ),
      );
    const settings = new Map<CheckTask, CheckSetting>();
    for (const rubric of rubrics) {
      if (!isCheckTask(rubric.task) || rubric.provider === 'none') continue;
      // A brand starts in shadow mode for every check.
      const mode = modes.find((m) => m.task === rubric.task)?.mode ?? 'shadow';
      if (mode === 'off') continue;
      settings.set(rubric.task, { task: rubric.task, mode, rubric });
    }
    return settings;
  }

  /**
   * Asks the rubric's provider, within the rubric's deadline (or less, when the caller has less
   * time), and holds each answer to its threshold for the language slice.
   */
  async ask(
    setting: CheckSetting,
    request: {
      state: DecisionState;
      questions: DecisionQuestions;
      language: LanguageSlice | null;
      deadlineMs?: number;
      keyOf?: (question: string) => string;
    },
  ): Promise<Asked> {
    const started = performance.now();
    const { rubric } = setting;
    const stateHash = sha256(canonicalize(request.state) ?? '');
    const rubricVersion = rubricVersionOf(rubric);
    const provider = this.providers.forRubric({
      provider: rubric.provider,
      modelVersion: rubric.modelVersion,
      intents: [],
    });
    const deadlineMs = Math.max(
      1,
      Math.floor(Math.min(rubric.deadlineMs, request.deadlineMs ?? rubric.deadlineMs)),
    );
    const result: DecisionResult<DecisionAnswers> = provider
      ? await provider.decide({
          task: setting.task,
          rubricVersion,
          state: request.state,
          questions: request.questions,
          ...(request.language ? { language: request.language } : {}),
          deadlineMs,
        })
      : {
          provider: 'none',
          task: setting.task,
          rubricVersion,
          latencyMs: 0,
          status: 'unavailable',
          retryable: false,
          reason: 'error',
        };
    const thresholds = request.language
      ? checkDefinitionOf(rubric).thresholds[request.language]
      : undefined;
    const gated = gateCheck(
      result,
      {
        provider: provider?.id ?? 'none',
        modelVersion:
          rubric.provider === 'mock'
            ? (rubric.modelVersion ?? MOCK_MODEL_VERSION)
            : (rubric.modelVersion ?? ''),
        rubricVersion,
      },
      thresholds,
      request.keyOf,
    );
    return {
      setting,
      result,
      gated,
      language: request.language,
      stateHash,
      totalMs: Math.round(performance.now() - started),
    };
  }

  /** The record values of an asked check; callers add what code concluded and did. */
  recordValues(
    asked: Asked,
    context: {
      tenantId: string;
      brandId: string;
      conversationId: string | null;
      runId: string | null;
      triggerRef: string;
    },
    outcome: {
      verdict: string;
      action: string;
      applied: boolean;
      detail?: Record<string, unknown>;
    },
  ): CheckInsert {
    const { result, gated, setting } = asked;
    return {
      tenantId: context.tenantId,
      brandId: context.brandId,
      conversationId: context.conversationId,
      runId: context.runId,
      task: setting.task,
      triggerRef: context.triggerRef,
      rubricId: setting.rubric.id,
      rubricVersion: setting.rubric.version,
      mode: setting.mode,
      provider: result.provider,
      modelVersion: 'modelVersion' in result ? (result.modelVersion ?? null) : null,
      status: gated.status,
      reason: gated.reason?.slice(0, 500) ?? null,
      retryable: result.status === 'unavailable' ? result.retryable : null,
      language: asked.language,
      verdict: outcome.verdict,
      action: outcome.action,
      applied: outcome.applied,
      answers: answersRecord(gated),
      detail: outcome.detail ?? {},
      latencyMs: Math.round(result.latencyMs),
      totalMs: asked.totalMs,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      requestId: result.requestId ?? null,
      policyVersion: rubricVersionOf(setting.rubric),
      stateHash: asked.stateHash,
    };
  }

  /** Writes a check record once; a retried run that checks the same thing again keeps the first. */
  async record(tenantId: string, values: CheckInsert, tx?: TenantTx): Promise<void> {
    const write = (t: TenantTx) =>
      t.insert(schema.decisionChecks).values(values).onConflictDoNothing();
    if (tx) {
      await write(tx);
      return;
    }
    await withTenant(this.db, { tenantId, actorId: 'checks' }, write);
  }
}
