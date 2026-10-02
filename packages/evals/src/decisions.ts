import { readFileSync } from 'node:fs';
import {
  baselineIntent,
  type DecisionProvider,
  type DecisionQuestions,
  detectHumanRequest,
  detectLanguage,
  LANGUAGE_QUESTION,
  LANGUAGE_SLICES,
  type LanguageSlice,
  OTHER_INTENT,
  PERSON_REQUEST_QUESTION,
  type RoutingIntent,
  redactPersonalData,
  routingQuestion,
  SLICE_OF_LANGUAGE,
} from '@hamnivo/domain';
import {
  atChoiceThreshold,
  brierBinary,
  brierChoice,
  type ChoiceThresholdOutcome,
  chooseChoiceThreshold,
  chooseNoulBand,
  expectedCalibrationError,
  type NoulBand,
  percentile,
} from './calibration.js';
import { loadFairnessCorpus } from './corpus.js';
import { groupBy, type Rate, wilson } from './stats.js';
import type { ReviewStatus, RoutingIntentSpec } from './types.js';

/**
 * Decision accuracy per language slice (J01, J02, J08): whether a decision provider recognises a
 * request for a person, the routing intent and the language of customer messages, with Brier score,
 * calibration error, abstention at thresholds, latency and token cost. Every item is one call with
 * the same three questions the product asks (speculative fan-out), so one run measures all three.
 */

/** Jev 1.13's published price: input tokens only, output is free. */
export const PRICE_PER_MILLION_INPUT_TOKENS = 0.042;
/** The synchronous chat path's budget for one decision. */
export const CHAT_DEADLINE_MS = 1500;
/** A run never makes more calls than this unless told to. */
export const DEFAULT_MAX_CALLS = 2000;

export interface RoutingCorpusItem {
  id: string;
  slice: LanguageSlice;
  intent: string;
  text: string;
}

export interface DecisionsRoutingCorpus {
  version: number;
  review: ReviewStatus;
  description: string;
  rubric: RoutingIntentSpec[];
  items: RoutingCorpusItem[];
}

interface HumanRequestCase {
  language: LanguageSlice;
  requested: boolean;
  text: string;
  why?: string;
}

export const loadRoutingCorpus = (): DecisionsRoutingCorpus =>
  JSON.parse(
    readFileSync(new URL('../corpus/decisions-routing.json', import.meta.url), 'utf8'),
  ) as DecisionsRoutingCorpus;

/** The hand-off fixtures of @hamnivo/domain (U02): requests for a person and look-alikes. */
export const loadHumanRequestCases = (): HumanRequestCase[] =>
  (
    JSON.parse(
      readFileSync(
        new URL('../../domain/test/fixtures/human-requests.json', import.meta.url),
        'utf8',
      ),
    ) as { cases: HumanRequestCase[] }
  ).cases;

export function routingCorpusProblems(corpus: DecisionsRoutingCorpus): string[] {
  const problems: string[] = [];
  const keys = new Set([...corpus.rubric.map((r) => r.key), OTHER_INTENT]);
  const ids = new Set<string>();
  for (const item of corpus.items) {
    if (ids.has(item.id)) problems.push(`${item.id}: duplicate id`);
    ids.add(item.id);
    if (!LANGUAGE_SLICES.includes(item.slice)) problems.push(`${item.id}: unknown slice`);
    if (!keys.has(item.intent)) problems.push(`${item.id}: intent ${item.intent} is not offered`);
    if (!item.text.trim()) problems.push(`${item.id}: no text`);
  }
  for (const slice of LANGUAGE_SLICES) {
    const mine = corpus.items.filter((i) => i.slice === slice);
    if (mine.length < 30) problems.push(`${slice}: only ${mine.length} items`);
    for (const key of keys) {
      if (!mine.some((i) => i.intent === key)) problems.push(`${slice}: no ${key} item`);
    }
  }
  return problems;
}

/** One message to judge, with whichever labels it has. */
export interface DecisionItem {
  id: string;
  source: 'routing' | 'handoff' | 'fairness';
  slice: LanguageSlice;
  text: string;
  /** Which topics the intent question offers: the routing corpus's or the U13 corpus's. */
  rubric: 'routing' | 'fairness';
  intent?: string;
  wantsPerson?: boolean;
  language?: LanguageSlice;
  /** U13 pair group: variants that must get the same decision. */
  group?: string;
}

/** Every labelled message: the routing corpus, the hand-off fixtures and the U13 pairs. */
export function decisionItems(
  routing = loadRoutingCorpus(),
  handoff = loadHumanRequestCases(),
  fairness = loadFairnessCorpus(),
): DecisionItem[] {
  const items: DecisionItem[] = routing.items.map((item) => ({
    id: item.id,
    source: 'routing',
    slice: item.slice,
    text: item.text,
    rubric: 'routing',
    intent: item.intent,
    wantsPerson: false,
    language: item.slice,
  }));
  handoff.forEach((c, index) => {
    items.push({
      id: `handoff-${index + 1}`,
      source: 'handoff',
      // The fixture's tag says which phrase list matched, not reliably the language: it is used
      // to break results down by slice, never as a language label.
      slice: c.language,
      text: c.text,
      rubric: 'routing',
      wantsPerson: c.requested,
    });
  });
  for (const group of fairness.groups) {
    if (group.decision === 'personal_data') continue;
    for (const variant of group.variants) {
      items.push({
        id: `${group.id}/${variant.id}`,
        source: 'fairness',
        slice: variant.slice,
        text: variant.text,
        rubric: group.decision === 'routing' ? 'fairness' : 'routing',
        group: group.id,
        language: variant.slice,
        ...(group.decision === 'routing'
          ? { intent: group.expected, wantsPerson: false }
          : { wantsPerson: group.expected === 'person' }),
      });
    }
  }
  return items;
}

const intentsOf = (specs: readonly RoutingIntentSpec[]): RoutingIntent[] =>
  specs.map((s) => ({ key: s.key, description: s.description, keywords: s.keywords }));

/** The questions every item is asked: the product's own. */
export function questionsFor(intents: readonly RoutingIntent[]) {
  return {
    wants_person: PERSON_REQUEST_QUESTION,
    intent: routingQuestion(intents),
    language: LANGUAGE_QUESTION,
  } as const satisfies DecisionQuestions;
}

/** What the provider sees: the product's routing state for one customer message. */
export const stateFor = (text: string) => ({
  messages: [redactPersonalData(text)],
  conversation: 'with_ai',
});

export interface ChoiceSeen {
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface CallRecord {
  itemId: string;
  slice: LanguageSlice;
  status: 'decided' | 'abstained' | 'unavailable' | 'invalid';
  reason: string | null;
  /** Calls made for this item, including retries after a provider failure. */
  attempts: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelVersion: string | null;
  wantsPerson: number | null;
  intent: ChoiceSeen | null;
  language: ChoiceSeen | null;
}

export interface RunOptions {
  provider: DecisionProvider;
  /** The pinned model, for the report. */
  model: string;
  maxCalls?: number;
  concurrency?: number;
  /** Deadline of one call; the report also counts calls slower than the chat path allows. */
  deadlineMs?: number;
  /** Retries after a retryable failure (rate limit, timeout, server error). */
  retries?: number;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const choiceSeen = (answer: unknown): ChoiceSeen | null => {
  const a = answer as { label?: unknown; confidence?: unknown; probabilities?: unknown } | null;
  if (!a || typeof a.label !== 'string' || typeof a.confidence !== 'number') return null;
  return {
    label: a.label,
    confidence: a.confidence,
    probabilities: { ...(a.probabilities as Record<string, number>) },
  };
};

/**
 * Asks the provider about every item, `concurrency` at a time, and never more than `maxCalls`
 * calls in total: a run that could need more is refused before the first call.
 */
export async function runDecisions(
  items: readonly DecisionItem[],
  options: RunOptions,
  rubrics: { routing: RoutingIntentSpec[]; fairness: RoutingIntentSpec[] } = {
    routing: loadRoutingCorpus().rubric,
    fairness: loadFairnessCorpus().rubric,
  },
): Promise<{ records: CallRecord[]; calls: number }> {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  if (items.length > maxCalls) {
    throw new Error(`${items.length} items need more than the ${maxCalls} calls allowed.`);
  }
  const retries = options.retries ?? 2;
  const questions = {
    routing: questionsFor(intentsOf(rubrics.routing)),
    fairness: questionsFor(intentsOf(rubrics.fairness)),
  };
  const records: CallRecord[] = new Array(items.length);
  let calls = 0;
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index] as DecisionItem;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        calls += 1;
        const result = await options.provider.decide({
          task: 'evaluation',
          rubricVersion: 'decisions-eval-1',
          state: stateFor(item.text),
          questions: questions[item.rubric],
          language: item.slice,
          deadlineMs: options.deadlineMs ?? 5000,
        });
        const retryable = result.status === 'unavailable' && result.retryable;
        if (retryable && attempts <= retries && calls < maxCalls) {
          await sleep(500 * attempts);
          continue;
        }
        const value = result.status === 'decided' ? result.value : null;
        records[index] = {
          itemId: item.id,
          slice: item.slice,
          status: result.status,
          reason: result.status === 'decided' ? null : result.reason,
          attempts,
          latencyMs: Math.round(result.latencyMs),
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          modelVersion: result.modelVersion ?? null,
          wantsPerson: value?.wants_person.probability ?? null,
          intent: choiceSeen(value?.intent ?? null),
          language: choiceSeen(value?.language ?? null),
        };
        break;
      }
      done += 1;
      options.onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  return { records, calls };
}

// ---------------------------------------------------------------------------------------------
// Metrics

export interface ChoiceMetrics {
  items: number;
  /** The provider's top answer was right. */
  accuracy: Rate;
  brier: number | null;
  calibrationError: number | null;
  /** The product's deterministic rule on the same items (what decides when the provider abstains). */
  baselineAccuracy: Rate;
  /** The lowest threshold at which decided answers were at least 90% right; null: never use. */
  threshold: ChoiceThresholdOutcome | null;
  /** The same items at fixed thresholds, for comparison. */
  sweep: ChoiceThresholdOutcome[];
}

export interface NoulMetrics {
  items: number;
  positives: number;
  /** p ≥ 0.5 matched the label. */
  accuracy: Rate;
  brier: number | null;
  calibrationError: number | null;
  baselineAccuracy: Rate;
  /** The band whose "true" answers were at least 95% precise; null: never act on it. */
  band: NoulBand | null;
}

export interface LatencyMetrics {
  calls: number;
  p50: number | null;
  p95: number | null;
  /** Calls slower than the chat path's 1.5 s deadline. */
  overChatDeadline: number;
}

export interface DecisionsReport {
  suite: 'decisions';
  provider: string;
  model: string;
  items: number;
  calls: number;
  failures: Record<string, number>;
  personRequest: { overall: NoulMetrics; bySlice: Record<string, NoulMetrics> };
  routing: { overall: ChoiceMetrics; bySlice: Record<string, ChoiceMetrics> };
  language: {
    overall: ChoiceMetrics;
    bySlice: Record<string, ChoiceMetrics>;
    /** Hinglish and Roman Urdu counted as one Latin-script Hindustani answer. */
    latinFamilyAccuracy: Rate;
  };
  /** U13: pairs whose variants got different answers from the provider. */
  consistency: { groups: number; consistent: number; findings: string[] };
  latency: { overall: LatencyMetrics; bySlice: Record<string, LatencyMetrics> };
  tokens: { input: number; output: number; perCall: number | null; costUsd: number };
  /** Items the provider got wrong, with the corpus text, for review. */
  errors: Array<{
    task: string;
    id: string;
    slice: string;
    text: string;
    expected: string;
    got: string;
    score: number;
  }>;
}

const SWEEP = [0.5, 0.7, 0.9];

function choiceMetrics(
  rows: Array<{ seen: ChoiceSeen; truth: string; baselineRight: boolean }>,
): ChoiceMetrics {
  const scored = rows.map((r) => ({
    confidence: r.seen.confidence,
    correct: r.seen.label === r.truth,
  }));
  return {
    items: rows.length,
    accuracy: wilson(scored.filter((s) => s.correct).length, rows.length),
    brier: brierChoice(rows.map((r) => ({ probabilities: r.seen.probabilities, truth: r.truth }))),
    calibrationError: expectedCalibrationError(
      scored.map((s) => ({ score: s.confidence, outcome: s.correct })),
    ),
    baselineAccuracy: wilson(rows.filter((r) => r.baselineRight).length, rows.length),
    threshold: chooseChoiceThreshold(scored),
    sweep: SWEEP.map((t) => atChoiceThreshold(scored, t)),
  };
}

function noulMetrics(rows: Array<{ p: number; y: boolean; baselineRight: boolean }>): NoulMetrics {
  return {
    items: rows.length,
    positives: rows.filter((r) => r.y).length,
    accuracy: wilson(rows.filter((r) => r.p >= 0.5 === r.y).length, rows.length),
    brier: brierBinary(rows),
    calibrationError: expectedCalibrationError(rows.map((r) => ({ score: r.p, outcome: r.y }))),
    baselineAccuracy: wilson(rows.filter((r) => r.baselineRight).length, rows.length),
    band: chooseNoulBand(rows),
  };
}

function latencyMetrics(records: readonly CallRecord[]): LatencyMetrics {
  const values = records.map((r) => r.latencyMs);
  return {
    calls: records.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    overChatDeadline: values.filter((v) => v > CHAT_DEADLINE_MS).length,
  };
}

function bySlice<T, M>(
  rows: readonly T[],
  sliceOf: (row: T) => string,
  metrics: (rows: T[]) => M,
): Record<string, M> {
  return Object.fromEntries(
    [...groupBy(rows, sliceOf)].map(([slice, list]) => [slice, metrics(list)]),
  );
}

const LATIN_FAMILY = new Set(['hinglish', 'roman-urdu']);

/** Scores recorded answers against the labels. Pure: thresholds can be chosen again offline. */
export function scoreDecisions(
  items: readonly DecisionItem[],
  records: readonly CallRecord[],
  meta: { provider: string; model: string; calls: number },
  rubrics: { routing: RoutingIntentSpec[]; fairness: RoutingIntentSpec[] } = {
    routing: loadRoutingCorpus().rubric,
    fairness: loadFairnessCorpus().rubric,
  },
): DecisionsReport {
  const byId = new Map(items.map((item) => [item.id, item]));
  const decided = records.filter((r) => r.status === 'decided');
  const failures: Record<string, number> = {};
  for (const r of records) {
    if (r.status !== 'decided') {
      const key = `${r.status}:${r.reason ?? 'unknown'}`;
      failures[key] = (failures[key] ?? 0) + 1;
    }
  }
  const errors: DecisionsReport['errors'] = [];
  const intents = { routing: intentsOf(rubrics.routing), fairness: intentsOf(rubrics.fairness) };

  const personRows = decided.flatMap((r) => {
    const item = byId.get(r.itemId);
    if (!item || item.wantsPerson === undefined || r.wantsPerson === null) return [];
    const row = {
      slice: item.slice,
      p: r.wantsPerson,
      y: item.wantsPerson,
      baselineRight: detectHumanRequest(item.text).requested === item.wantsPerson,
    };
    if (row.p >= 0.5 !== row.y) {
      errors.push({
        task: 'person-request',
        id: item.id,
        slice: item.slice,
        text: item.text,
        expected: item.wantsPerson ? 'asks for a person' : 'does not',
        got: `p=${row.p}`,
        score: row.p,
      });
    }
    return [row];
  });

  const routingRows = decided.flatMap((r) => {
    const item = byId.get(r.itemId);
    if (!item?.intent || !r.intent) return [];
    const baseline = baselineIntent(item.text, intents[item.rubric]).intent;
    if (r.intent.label !== item.intent) {
      errors.push({
        task: 'routing',
        id: item.id,
        slice: item.slice,
        text: item.text,
        expected: item.intent,
        got: r.intent.label,
        score: r.intent.confidence,
      });
    }
    return [
      {
        slice: item.slice,
        seen: r.intent,
        truth: item.intent,
        baselineRight: baseline === item.intent,
      },
    ];
  });

  const languageRows = decided.flatMap((r) => {
    const item = byId.get(r.itemId);
    if (!item?.language || !r.language) return [];
    const detected = detectLanguage(item.text).language;
    const baseline = detected ? SLICE_OF_LANGUAGE[detected] : null;
    if (r.language.label !== item.language) {
      errors.push({
        task: 'language',
        id: item.id,
        slice: item.slice,
        text: item.text,
        expected: item.language,
        got: r.language.label,
        score: r.language.confidence,
      });
    }
    return [
      {
        slice: item.slice,
        seen: r.language,
        truth: item.language,
        baselineRight: baseline === item.language,
      },
    ];
  });
  const family = (label: string) => (LATIN_FAMILY.has(label) ? 'latin-hindustani' : label);

  // U13: the provider's answers within a pair group.
  const groups = groupBy(
    items.filter((i) => i.group),
    (i) => i.group as string,
  );
  const findings: string[] = [];
  let consistent = 0;
  const recordOf = new Map(records.map((r) => [r.itemId, r]));
  for (const [group, members] of groups) {
    const answers = members.map((m) => {
      const r = recordOf.get(m.id);
      if (r?.status !== 'decided') return 'unavailable';
      return m.intent !== undefined
        ? (r.intent?.label ?? 'none')
        : (r.wantsPerson ?? 0) >= 0.5
          ? 'person'
          : 'no_person';
    });
    if (new Set(answers).size === 1) consistent += 1;
    else
      findings.push(
        `${group}: ${members.map((m, i) => `${m.id.split('/')[1]}=${answers[i]}`).join(', ')}`,
      );
  }

  const input = decided.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const output = decided.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
  const withTokens = decided.filter((r) => r.inputTokens !== null).length;
  return {
    suite: 'decisions',
    provider: meta.provider,
    model: meta.model,
    items: items.length,
    calls: meta.calls,
    failures,
    personRequest: {
      overall: noulMetrics(personRows),
      bySlice: bySlice(personRows, (r) => r.slice, noulMetrics),
    },
    routing: {
      overall: choiceMetrics(routingRows),
      bySlice: bySlice(routingRows, (r) => r.slice, choiceMetrics),
    },
    language: {
      overall: choiceMetrics(languageRows),
      bySlice: bySlice(languageRows, (r) => r.slice, choiceMetrics),
      latinFamilyAccuracy: wilson(
        languageRows.filter(
          (r) => LATIN_FAMILY.has(r.truth) && family(r.seen.label) === family(r.truth),
        ).length,
        languageRows.filter((r) => LATIN_FAMILY.has(r.truth)).length,
      ),
    },
    consistency: { groups: groups.size, consistent, findings },
    latency: {
      overall: latencyMetrics(records),
      bySlice: bySlice([...records], (r) => r.slice, latencyMetrics),
    },
    tokens: {
      input,
      output,
      perCall: withTokens === 0 ? null : Math.round(input / withTokens),
      costUsd: Math.round(((input * PRICE_PER_MILLION_INPUT_TOKENS) / 1e6) * 1e6) / 1e6,
    },
    errors: errors.sort((a, b) => a.task.localeCompare(b.task) || b.score - a.score),
  };
}
