import {
  type AnswerFor,
  type DecisionAnswers,
  type DecisionAudit,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  validateDecisionRequest,
} from './decisions.js';
import { normalizeForMatching } from './human-request.js';

/** Keywords per choice label, per score level, or for a true noul. */
export type MockDecisionRule =
  | { type: 'choice'; keywords: Readonly<Record<string, readonly string[]>> }
  | { type: 'score'; keywords: Readonly<Record<number, readonly string[]>> }
  | { type: 'noul'; keywords: readonly string[] };

export interface MockDecisionProviderOptions {
  /** Rules by question name. A question without a rule gets a low-confidence default. */
  rules?: Readonly<Record<string, MockDecisionRule>>;
  modelVersion?: string;
  latencyMs?: number;
}

const MATCHED = 0.9;
const UNMATCHED = 0.4;
const FALLBACK_LABELS = ['other', 'unknown', 'none'];

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** Spreads what is left over the other options, so probabilities add up to 1. */
function spread<K extends string>(keys: readonly K[], chosen: K, p: number): Record<K, number> {
  const rest = keys.length > 1 ? round((1 - p) / (keys.length - 1)) : 0;
  return Object.fromEntries(keys.map((key) => [key, key === chosen ? p : rest])) as Record<
    K,
    number
  >;
}

function answer(
  question: DecisionQuestion,
  rule: MockDecisionRule | undefined,
  matches: (keywords: readonly string[]) => boolean,
): AnswerFor<DecisionQuestion> | string {
  if (rule && rule.type !== question.type)
    return `a ${rule.type} rule cannot answer a ${question.type}`;
  switch (question.type) {
    case 'choice': {
      const labels = Object.keys(question.labels);
      const keywords = rule?.type === 'choice' ? rule.keywords : {};
      const hit = labels.find((label) => matches(keywords[label] ?? []));
      const label = hit ?? FALLBACK_LABELS.find((l) => labels.includes(l)) ?? labels[0] ?? '';
      const confidence = hit ? MATCHED : UNMATCHED;
      return {
        type: 'choice',
        label,
        confidence,
        probabilities: spread(labels, label, confidence),
      };
    }
    case 'score': {
      const levels = question.rubric.map((_, level) => String(level));
      const keywords = rule?.type === 'score' ? rule.keywords : {};
      const hit = levels.findLast((level) => matches(keywords[Number(level)] ?? []));
      const confidence = hit ? MATCHED : UNMATCHED;
      const probabilities = spread(levels, hit ?? '0', confidence);
      const expected = levels.reduce(
        (sum, level) => sum + Number(level) * (probabilities[level] ?? 0),
        0,
      );
      return { type: 'score', score: round(expected), confidence, probabilities };
    }
    case 'noul': {
      if (rule?.type !== 'noul') return { type: 'noul', probability: 0.5 };
      return { type: 'noul', probability: matches(rule.keywords) ? MATCHED : 0.1 };
    }
  }
}

/**
 * A deterministic, offline `DecisionProvider` for tests and development. It answers from keyword
 * rules matched against the normalized state, with the same result contract as a real provider.
 */
export function createMockDecisionProvider(
  options: MockDecisionProviderOptions = {},
): DecisionProvider {
  const modelVersion = options.modelVersion ?? 'decision-mock-1';
  return {
    id: 'mock',
    async decide<const Q extends DecisionQuestions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResult<DecisionAnswers<Q>>> {
      const audit: DecisionAudit = {
        provider: 'mock',
        task: request.task,
        rubricVersion: request.rubricVersion,
        latencyMs: options.latencyMs ?? 0,
        ...(request.language ? { language: request.language } : {}),
      };
      const problem = validateDecisionRequest(request);
      if (problem) return { ...audit, status: 'invalid', reason: problem };
      if (request.signal?.aborted) {
        return { ...audit, status: 'unavailable', retryable: false, reason: 'aborted' };
      }

      const state =
        typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
      const text = ` ${normalizeForMatching(state)} `;
      const matches = (keywords: readonly string[]) =>
        keywords.some((keyword) => text.includes(` ${normalizeForMatching(keyword)} `));
      const rules = options.rules ?? {};
      const answers: [string, AnswerFor<DecisionQuestion>][] = [];
      let words = text.split(' ').filter(Boolean).length;
      for (const [name, question] of Object.entries<DecisionQuestion>(request.questions)) {
        const outcome = answer(
          question,
          Object.hasOwn(rules, name) ? rules[name] : undefined,
          matches,
        );
        if (typeof outcome === 'string') {
          return { ...audit, status: 'invalid', reason: `question "${name}": ${outcome}` };
        }
        answers.push([name, outcome]);
        words += question.instructions.split(/\s+/).length;
      }
      return {
        ...audit,
        status: 'decided',
        modelVersion,
        usage: { inputTokens: words, outputTokens: answers.length },
        value: Object.fromEntries(answers) as DecisionAnswers<Q>,
      };
    },
  };
}
