import type {
  CheckQuestion,
  CheckRecord,
  CheckRubric,
  CheckTaskName,
  CheckThresholds,
  LanguageSlice,
} from '@hamnivo/contracts';
import { toPublicId } from '@hamnivo/db';
import { type CheckTask, LANGUAGE_SLICES, relationQuestion } from '@hamnivo/domain';
import { iso } from '../common/views.js';
import { type CheckRow, checkDefinitionOf, type RubricRow } from './checks.service.js';

/** What each check asks, as staff see it in Studio (the wording Jev reads, numbers in code). */
export function checkQuestions(task: CheckTask): CheckQuestion[] {
  switch (task) {
    case 'answer-check': {
      const question = relationQuestion(1, 1);
      return [
        {
          key: 'relation',
          type: 'choice',
          instructions: question.instructions,
          options: { ...question.labels },
        },
      ];
    }
  }
}

export function checkRubricView(row: RubricRow): CheckRubric {
  return {
    id: toPublicId('rubric', row.id),
    brandId: toPublicId('brand', row.brandId),
    task: row.task as CheckTaskName,
    version: row.version,
    state: row.state,
    thresholds: checkDefinitionOf(row).thresholds as CheckThresholds,
    provider: row.provider,
    modelVersion: row.modelVersion,
    deadlineMs: row.deadlineMs,
    configHash: row.configHash ? row.configHash.toString('hex') : null,
    createdAt: row.createdAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy ? toPublicId('staff', row.publishedBy) : null,
  };
}

const slice = (value: string | null): LanguageSlice | null =>
  value && (LANGUAGE_SLICES as readonly string[]).includes(value) ? (value as LanguageSlice) : null;

export function checkRecordView(row: CheckRow): CheckRecord {
  return {
    id: toPublicId('check', row.id),
    brandId: toPublicId('brand', row.brandId),
    conversationId: row.conversationId ? toPublicId('conversation', row.conversationId) : null,
    runId: row.runId ? toPublicId('run', row.runId) : null,
    task: row.task as CheckTaskName,
    mode: row.mode,
    provider: row.provider,
    modelVersion: row.modelVersion,
    rubricVersion: row.rubricVersion,
    status: row.status,
    reason: row.reason,
    retryable: row.retryable,
    language: slice(row.language),
    verdict: row.verdict,
    action: row.action,
    applied: row.applied,
    answers: (row.answers ?? {}) as Record<string, Record<string, unknown>>,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    latencyMs: row.latencyMs,
    totalMs: row.totalMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt.toISOString(),
  };
}
