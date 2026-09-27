import type {
  DecisionRecord,
  DecisionRubric,
  LanguageSlice,
  RoutingTeam,
  RubricDefinition,
} from '@hamnivo/contracts';
import { schema, toPublicId } from '@hamnivo/db';
import { LANGUAGE_SLICES, type RoutingIntent, type RoutingTeam as TeamRule } from '@hamnivo/domain';
import { iso } from '../common/views.js';

export type TeamRow = typeof schema.routingTeams.$inferSelect;
export type RubricRow = typeof schema.decisionRubrics.$inferSelect;
export type RecordRow = typeof schema.decisionRecords.$inferSelect;

export const ROUTING_TASK = 'team-routing';

const slices = (values: readonly string[]): LanguageSlice[] =>
  values.filter((v): v is LanguageSlice => (LANGUAGE_SLICES as readonly string[]).includes(v));

export function teamView(row: TeamRow): RoutingTeam {
  return {
    id: toPublicId('team', row.id),
    brandId: toPublicId('brand', row.brandId),
    name: row.name,
    intents: row.intents,
    languages: slices(row.languages),
    translationLanguages: slices(row.translationLanguages),
    externalTeamId: row.externalTeamId,
    isDefault: row.isDefault,
    accepting: row.accepting,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A team as the routing rules see it; archived teams are never permitted. */
export function teamRule(row: TeamRow): TeamRule {
  return {
    id: row.id,
    intents: row.intents,
    languages: slices(row.languages),
    translationLanguages: slices(row.translationLanguages),
    accepting: row.accepting && row.status === 'active',
    isDefault: row.isDefault,
  };
}

export function definitionOf(row: RubricRow): RubricDefinition {
  return row.definition as RubricDefinition;
}

export function intentsOf(row: RubricRow): RoutingIntent[] {
  return definitionOf(row).intents.map((i) => ({
    key: i.key,
    description: i.description,
    keywords: i.keywords,
  }));
}

export function rubricView(row: RubricRow): DecisionRubric {
  return {
    id: toPublicId('rubric', row.id),
    brandId: toPublicId('brand', row.brandId),
    task: 'team-routing',
    version: row.version,
    state: row.state,
    definition: definitionOf(row),
    provider: row.provider,
    modelVersion: row.modelVersion,
    deadlineMs: row.deadlineMs,
    configHash: row.configHash ? row.configHash.toString('hex') : null,
    createdAt: row.createdAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy ? toPublicId('staff', row.publishedBy) : null,
  };
}

export function recordView(row: RecordRow, teamName: string | null): DecisionRecord {
  return {
    id: toPublicId('decision', row.id),
    brandId: toPublicId('brand', row.brandId),
    conversationId: row.conversationId ? toPublicId('conversation', row.conversationId) : null,
    task: 'team-routing',
    trigger: row.trigger,
    mode: row.mode,
    provider: row.provider,
    modelVersion: row.modelVersion,
    rubricVersion: row.rubricVersion,
    status: row.status,
    reason: row.reason,
    retryable: row.retryable,
    providerIntent: row.providerIntent,
    confidence: row.confidence,
    baselineIntent: row.baselineIntent,
    finalIntent: row.finalIntent,
    finalSource: row.finalSource,
    fallback: row.fallback,
    team: row.teamId ? { id: toPublicId('team', row.teamId), name: teamName ?? '' } : null,
    teamBasis: row.teamBasis,
    languageMatch: row.languageMatch,
    language: (slices(row.language ? [row.language] : [])[0] ?? null) as LanguageSlice | null,
    explicitRequest: row.explicitRequest,
    applied: row.applied,
    latencyMs: row.latencyMs,
    totalMs: row.totalMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    requestId: row.requestId,
    policyVersion: row.policyVersion,
    offered: row.offered,
    review:
      row.reviewedIntent && row.reviewedAt
        ? {
            intent: row.reviewedIntent,
            reason: row.reviewReason ?? '',
            reviewedBy: row.reviewedBy ? toPublicId('staff', row.reviewedBy) : null,
            reviewedAt: row.reviewedAt.toISOString(),
            trainingConsent: row.trainingConsent,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}
