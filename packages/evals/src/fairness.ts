import { baselineIntent, detectHumanRequest, findPersonalData } from '@hamnivo/domain';
import { groupBy, type Rate, wilson } from './stats.js';
import type {
  FairnessCorpus,
  FairnessDecision,
  FairnessGroup,
  RoutingIntentSpec,
} from './types.js';

/**
 * The product decisions a fairness pair checks (U13), exactly as the product makes them: the
 * routing baseline's topic, whether the customer asked for a person, and which personal data
 * the privacy check finds. None of them may depend on a name, gender, politeness or script.
 */
export function decide(
  decision: FairnessDecision,
  text: string,
  rubric: readonly RoutingIntentSpec[],
): string {
  switch (decision) {
    case 'routing':
      return baselineIntent(text, rubric).intent;
    case 'handoff':
      return detectHumanRequest(text).requested ? 'person' : 'no_person';
    case 'personal_data':
      return [...findPersonalData(text)].sort().join(',') || 'none';
  }
}

export interface FairnessGroupResult {
  id: string;
  decision: FairnessDecision;
  attribute: FairnessGroup['attribute'];
  expected: string;
  outcomes: Array<{ variant: string; slice: string; outcome: string }>;
  /** Every variant got the same decision. */
  consistent: boolean;
  /** Every variant got the expected decision. */
  correct: boolean;
}

export interface FairnessReport {
  suite: 'fairness';
  groups: FairnessGroupResult[];
  consistency: Rate;
  accuracy: Rate;
  byAttribute: Record<string, { consistency: Rate; accuracy: Rate }>;
  byDecision: Record<string, { consistency: Rate; accuracy: Rate }>;
  /** Variants whose decision differs from the expected one: disparities to investigate. */
  findings: Array<{
    group: string;
    variant: string;
    slice: string;
    expected: string;
    outcome: string;
  }>;
}

const summary = (results: readonly FairnessGroupResult[]) => ({
  consistency: wilson(results.filter((r) => r.consistent).length, results.length),
  accuracy: wilson(results.filter((r) => r.correct).length, results.length),
});

export function runFairness(corpus: FairnessCorpus): FairnessReport {
  const groups = corpus.groups.map((group): FairnessGroupResult => {
    const outcomes = group.variants.map((variant) => ({
      variant: variant.id,
      slice: variant.slice,
      outcome: decide(group.decision, variant.text, corpus.rubric),
    }));
    return {
      id: group.id,
      decision: group.decision,
      attribute: group.attribute,
      expected: group.expected,
      outcomes,
      consistent: new Set(outcomes.map((o) => o.outcome)).size === 1,
      correct: outcomes.every((o) => o.outcome === group.expected),
    };
  });
  return {
    suite: 'fairness',
    groups,
    ...summary(groups),
    byAttribute: Object.fromEntries(
      [...groupBy(groups, (g) => g.attribute)].map(([key, list]) => [key, summary(list)]),
    ),
    byDecision: Object.fromEntries(
      [...groupBy(groups, (g) => g.decision)].map(([key, list]) => [key, summary(list)]),
    ),
    findings: groups.flatMap((group) =>
      group.outcomes
        .filter((o) => o.outcome !== group.expected)
        .map((o) => ({
          group: group.id,
          variant: o.variant,
          slice: o.slice,
          expected: group.expected,
          outcome: o.outcome,
        })),
    ),
  };
}
