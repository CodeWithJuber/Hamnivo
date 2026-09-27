import type {
  ChoiceAnswer,
  DecisionAnswers,
  DecisionQuestion,
  DecisionQuestions,
  DecisionResult,
  DecisionUsage,
  NoulAnswer,
  ScoreAnswer,
  UnavailableReason,
} from '@hamnivo/domain';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  choice,
  noul,
  type Question,
  type Questions,
  RateLimitError,
  score,
  TypeSafeError,
} from '@typesafe-ai/sdk';
import type { CallHealth } from './breaker.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A result without the fields the provider adds itself, and what it says about Jev's health. */
export interface JevOutcome<T> {
  result: DistributiveOmit<
    DecisionResult<T>,
    'provider' | 'task' | 'rubricVersion' | 'language' | 'latencyMs'
  >;
  health: CallHealth;
}

function toJevQuestion(question: DecisionQuestion): Question {
  switch (question.type) {
    case 'choice':
      return choice(question.instructions, { ...question.labels });
    case 'score':
      return score(question.instructions, question.rubric);
    case 'noul':
      return noul(question.instructions, question.outcomes);
  }
}

/** Neutral questions to the SDK's keyed map (E08: a map by name, never an array). */
export function toJevQuestions(questions: DecisionQuestions): Questions {
  return Object.fromEntries(
    Object.entries<DecisionQuestion>(questions).map(([name, q]) => [name, toJevQuestion(q)]),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
/** Short and free of state, for reasons that may end up in audit records. */
const show = (value: unknown) =>
  typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : typeof value;

function readProbabilities(
  raw: unknown,
  allowed: (key: string) => boolean,
): Record<string, number> | string {
  if (!isRecord(raw)) return 'probabilities must be a map';
  const entries: [string, number][] = [];
  for (const [key, p] of Object.entries(raw)) {
    if (!allowed(key)) return `probability for unknown option ${show(key)}`;
    if (!isUnit(p)) return `probability for ${show(key)} must be from 0 to 1`;
    entries.push([key, p]);
  }
  return Object.fromEntries(entries);
}

function readAnswer(
  question: DecisionQuestion,
  raw: unknown,
): ChoiceAnswer | ScoreAnswer | NoulAnswer | string {
  if (!isRecord(raw)) return 'the answer is not an object';
  if (raw.type !== question.type) {
    return `expected a ${question.type} answer, got ${show(raw.type)}`;
  }
  switch (question.type) {
    case 'choice': {
      const offered = (label: string) => Object.hasOwn(question.labels, label);
      if (typeof raw.choice !== 'string' || !offered(raw.choice)) {
        return `label ${show(raw.choice)} was not offered`;
      }
      if (!isUnit(raw.confidence)) return 'confidence must be from 0 to 1';
      const probabilities = readProbabilities(raw.probabilities, offered);
      if (typeof probabilities === 'string') return probabilities;
      return { type: 'choice', label: raw.choice, confidence: raw.confidence, probabilities };
    }
    case 'score': {
      const top = question.rubric.length - 1;
      const value = raw.score;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > top) {
        return `score must be from 0 to ${top}`;
      }
      if (!isUnit(raw.confidence)) return 'confidence must be from 0 to 1';
      const probabilities = readProbabilities(
        raw.probabilities,
        (level) => /^(0|[1-9]\d*)$/.test(level) && Number(level) <= top,
      );
      if (typeof probabilities === 'string') return probabilities;
      return { type: 'score', score: value, confidence: raw.confidence, probabilities };
    }
    case 'noul':
      // Only the probability crosses over: Noul has no confidence, whatever else the wire carries.
      return isUnit(raw.noul)
        ? { type: 'noul', probability: raw.noul }
        : 'noul must be a probability from 0 to 1';
  }
}

function readUsage(raw: unknown): DecisionUsage | undefined {
  if (!isRecord(raw) || !isCount(raw.input_tokens) || !isCount(raw.output_tokens)) return undefined;
  return { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
}

/**
 * Validates a `systemone` response against the questions asked. Every question needs an answer of
 * its type, labels must be ones offered, numbers finite and probabilities within 0..1. Anything
 * else is `invalid`, with the model, usage and request id kept when they could be read.
 */
export function readJevResponse<Q extends DecisionQuestions>(
  questions: Q,
  data: unknown,
  pinnedModel: string,
  requestId: string | undefined,
): JevOutcome<DecisionAnswers<Q>> {
  const known: { requestId?: string; modelVersion?: string; usage?: DecisionUsage } = {};
  if (requestId) known.requestId = requestId;
  const invalid = (reason: string): JevOutcome<DecisionAnswers<Q>> => ({
    health: 'success',
    result: { ...known, status: 'invalid', reason: `Jev answer: ${reason}` },
  });
  if (!isRecord(data)) return invalid('the response is not a JSON object');
  const usage = readUsage(data.usage);
  if (usage) known.usage = usage;
  if (typeof data.model !== 'string' || data.model === '') return invalid('no model version');
  known.modelVersion = data.model;
  // Thresholds are evaluated per model version, so an answer from any other model is not usable.
  if (data.model !== pinnedModel) {
    return invalid(`from ${data.model}, not the pinned ${pinnedModel}`);
  }
  if (!usage) return invalid('no valid token usage');
  const answers = data.answers;
  if (!isRecord(answers)) return invalid('answers must be a map keyed by question name');

  const read: [string, ChoiceAnswer | ScoreAnswer | NoulAnswer][] = [];
  for (const [name, question] of Object.entries<DecisionQuestion>(questions)) {
    if (!Object.hasOwn(answers, name)) return invalid(`no answer for "${name}"`);
    const answer = readAnswer(question, answers[name]);
    if (typeof answer === 'string') return invalid(`"${name}": ${answer}`);
    read.push([name, answer]);
  }
  return {
    health: 'success',
    result: {
      ...known,
      status: 'decided',
      modelVersion: data.model,
      usage,
      value: Object.fromEntries(read) as DecisionAnswers<Q>,
    },
  };
}

/**
 * Maps a failed call. Caller cancellation is `unavailable` and not retryable (the caller chose to
 * stop) and says nothing about Jev's health. The total deadline, 429, 5xx and connection failures
 * are retryable; 401/403/404 are not. 400/422 mean the request itself was refused: `invalid`.
 */
export function fromJevError(
  error: unknown,
  signals: { callerAborted: boolean; deadlinePassed: boolean },
): JevOutcome<never> {
  const unavailable = (
    reason: UnavailableReason,
    retryable: boolean,
    extra: { requestId?: string; retryAfterMs?: number } = {},
  ): JevOutcome<never> => ({
    health: 'failure',
    result: { ...extra, status: 'unavailable', retryable, reason },
  });
  if (signals.callerAborted) {
    return {
      health: 'neutral',
      result: { status: 'unavailable', retryable: false, reason: 'aborted' },
    };
  }
  if (signals.deadlinePassed || error instanceof APITimeoutError) {
    return unavailable('deadline', true);
  }
  if (error instanceof APIError) {
    const meta = error.requestId ? { requestId: error.requestId } : {};
    if (error instanceof RateLimitError) {
      const after = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs };
      return unavailable('rate_limited', true, { ...meta, ...after });
    }
    if (error.status === 401 || error.status === 403) return unavailable('auth', false, meta);
    if (error.status === 404) return unavailable('not_found', false, meta);
    if (error.status === 408 || error.status >= 500) return unavailable('server_error', true, meta);
    return {
      health: 'success',
      result: {
        ...meta,
        status: 'invalid',
        reason: `Jev refused the request (HTTP ${error.status})`,
      },
    };
  }
  if (error instanceof APIConnectionError) return unavailable('connection', true);
  if (error instanceof TypeSafeError) {
    return { health: 'neutral', result: { status: 'invalid', reason: `SDK: ${error.message}` } };
  }
  return unavailable('error', true);
}
