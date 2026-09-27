import { describe, expect, it } from 'vitest';
import {
  applyThreshold,
  createMockDecisionProvider,
  type DecisionAnswers,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  type QuestionThreshold,
  ROUTING_OUTCOMES,
  type ThresholdPolicy,
  validateDecisionRequest,
} from '../src/index.js';

const questions = {
  intent: {
    type: 'choice',
    instructions: 'What is the customer asking about?',
    labels: { billing: 'Payments and invoices', delivery: 'Shipping', other: null },
  },
  evidence: {
    type: 'score',
    instructions: 'How well does the evidence support an answer?',
    rubric: ['No support', 'Partial', 'Full'],
  },
  needsHuman: { type: 'noul', instructions: 'The customer needs a person to resolve this.' },
} as const satisfies DecisionQuestions;

type Answers = DecisionAnswers<typeof questions>;

const decided = (
  overrides: Partial<Answers> = {},
  audit: { language?: 'en' | 'ur'; modelVersion?: string } = {},
): DecisionResult<Answers> => ({
  status: 'decided',
  provider: 'jev',
  task: 'handoff-advisory',
  rubricVersion: 'handoff-v1',
  language: 'language' in audit ? audit.language : 'en',
  modelVersion: audit.modelVersion ?? 'jev-1.13.0',
  latencyMs: 120,
  usage: { inputTokens: 210, outputTokens: 9 },
  requestId: 'req_1',
  value: {
    intent: {
      type: 'choice',
      label: 'delivery',
      confidence: 0.82,
      probabilities: { billing: 0.08, delivery: 0.87, other: 0.05 },
    },
    evidence: {
      type: 'score',
      score: 1.6,
      confidence: 0.71,
      probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 },
    },
    needsHuman: { type: 'noul', probability: 0.12 },
    ...overrides,
  },
});

const EN: Record<string, QuestionThreshold> = {
  intent: { type: 'choice', minConfidence: 0.7 },
  evidence: { type: 'score', minConfidence: 0.6 },
  needsHuman: { type: 'noul', trueAtLeast: 0.8, falseAtMost: 0.2 },
};

const policyFor = (
  en: Record<string, QuestionThreshold>,
  evaluatedWith = { provider: 'jev', modelVersion: 'jev-1.13.0' },
): ThresholdPolicy => ({
  version: 'thresholds-2026-09-27',
  tasks: {
    'handoff-advisory': { ...evaluatedWith, rubricVersion: 'handoff-v1', languages: { en } },
  },
});
const policy = policyFor(EN);

describe('applyThreshold', () => {
  it('keeps a decision when every answer clears its threshold, with a verdict for noul', () => {
    const result = applyThreshold(decided(), policy);
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.policyVersion).toBe('thresholds-2026-09-27');
    expect(result.value.intent.label).toBe('delivery');
    expect(result.value.needsHuman).toEqual({ type: 'noul', probability: 0.12, verdict: false });
    const yes = applyThreshold(
      decided({ needsHuman: { type: 'noul', probability: 0.93 } }),
      policy,
    );
    expect(yes.status === 'decided' && yes.value.needsHuman.verdict).toBe(true);
  });

  it('abstains below a threshold and keeps what was observed for audit', () => {
    const low = decided({
      intent: { type: 'choice', label: 'billing', confidence: 0.42, probabilities: {} },
    });
    const result = applyThreshold(low, policy);
    expect(result).toMatchObject({
      status: 'abstained',
      reason: '"intent" confidence 0.42 is below 0.7',
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      usage: { inputTokens: 210, outputTokens: 9 },
      requestId: 'req_1',
      latencyMs: 120,
      policyVersion: 'thresholds-2026-09-27',
    });
    expect(result.status === 'abstained' && result.observed?.intent.label).toBe('billing');
    expect(result).not.toHaveProperty('value');
  });

  it('applies noul thresholds to the probability, never to a confidence', () => {
    const unsure = decided({ needsHuman: { type: 'noul', probability: 0.55 } });
    expect(applyThreshold(unsure, policy)).toMatchObject({
      status: 'abstained',
      reason: '"needsHuman" probability 0.55 is between 0.2 and 0.8',
    });
    const result = applyThreshold(decided(), policy);
    expect(result.status === 'decided' && result.value.needsHuman).not.toHaveProperty('confidence');
  });

  it('abstains for a language that was not evaluated, or no language at all', () => {
    expect(applyThreshold(decided({}, { language: 'ur' }), policy)).toMatchObject({
      status: 'abstained',
      reason: 'not evaluated for this language (ur)',
    });
    expect(applyThreshold(decided({}, { language: undefined }), policy)).toMatchObject({
      status: 'abstained',
      reason: 'no language slice: not evaluated for this language',
    });
  });

  it('abstains when the task, model or rubric differs from what was evaluated', () => {
    expect(applyThreshold({ ...decided(), task: 'triage' }, policy)).toMatchObject({
      status: 'abstained',
      reason: 'no thresholds for task "triage"',
    });
    const other = applyThreshold(decided({}, { modelVersion: 'jev-1.14.0' }), policy);
    expect(other).toMatchObject({ status: 'abstained' });
    expect(other.status === 'abstained' && other.reason).toContain('not jev jev-1.14.0');
    const rubric = applyThreshold({ ...decided(), rubricVersion: 'handoff-v2' }, policy);
    expect(rubric.status).toBe('abstained');
  });

  it('abstains when a question has no threshold or a malformed one', () => {
    const missing = policyFor({ intent: EN.intent!, needsHuman: EN.needsHuman! });
    expect(applyThreshold(decided(), missing)).toMatchObject({
      status: 'abstained',
      reason: 'no threshold for "evidence"',
    });
    const inverted = policyFor({
      ...EN,
      needsHuman: { type: 'noul', trueAtLeast: 0.3, falseAtMost: 0.6 },
    });
    expect(applyThreshold(decided(), inverted)).toMatchObject({
      status: 'abstained',
      reason: 'the threshold for "needsHuman" is malformed',
    });
    const wrongType = policyFor({ ...EN, needsHuman: { type: 'choice', minConfidence: 0.5 } });
    expect(applyThreshold(decided(), wrongType)).toMatchObject({
      status: 'abstained',
      reason: 'the threshold for "needsHuman" is for another type',
    });
  });

  it('passes other statuses through; unavailable is never turned into an answer', () => {
    const unavailable: DecisionResult<Answers> = {
      status: 'unavailable',
      retryable: true,
      reason: 'deadline',
      provider: 'jev',
      task: 'handoff-advisory',
      rubricVersion: 'handoff-v1',
      latencyMs: 1500,
    };
    expect(applyThreshold(unavailable, policy)).toEqual({
      ...unavailable,
      policyVersion: 'thresholds-2026-09-27',
    });
  });
});

describe('validateDecisionRequest', () => {
  const base: DecisionRequest = {
    task: 'handoff-advisory',
    rubricVersion: 'handoff-v1',
    state: 'I was charged twice.',
    questions,
  };

  it('accepts a well-formed keyed request', () => {
    expect(validateDecisionRequest(base)).toBeUndefined();
  });

  it.each([
    [{ task: ' ' }, 'task is required'],
    [{ rubricVersion: '' }, 'rubricVersion is required'],
    [{ questions: {} }, 'at least one question is required'],
    [{ questions: [questions.intent] }, 'questions must be a map keyed by question name'],
    [
      { questions: { q: { type: 'choice', instructions: 'Pick', labels: { only: null } } } },
      'question "q": offer at least two labels',
    ],
    [
      { questions: { q: { type: 'score', instructions: 'Rate', rubric: ['one'] } } },
      'question "q": the rubric needs at least two levels',
    ],
    [{ questions: { q: { type: 'rank', instructions: 'x' } } }, 'question "q": type must be'],
    [{ deadlineMs: 0 }, 'deadlineMs must be a positive number'],
    [{ language: 'fr' }, 'unknown language slice "fr"'],
    [{ state: undefined }, 'state is required'],
  ])('rejects %j', (change, reason) => {
    expect(validateDecisionRequest({ ...base, ...change } as DecisionRequest)).toContain(reason);
  });
});

describe('routing outcomes', () => {
  it('are separate from provider result statuses', () => {
    expect(ROUTING_OUTCOMES).toEqual([
      'AI_CONTINUE',
      'ASK_CLARIFICATION',
      'INVITE_SPECIALIST',
      'HUMAN_REVIEW',
      'HUMAN_TAKEOVER',
      'BLOCK_ACTION',
    ]);
    for (const status of ['decided', 'abstained', 'unavailable', 'invalid']) {
      expect(ROUTING_OUTCOMES).not.toContain(status);
    }
  });
});

describe('createMockDecisionProvider', () => {
  const mock = createMockDecisionProvider({
    rules: {
      intent: {
        type: 'choice',
        keywords: { billing: ['charged', 'invoice'], delivery: ['parcel'] },
      },
      evidence: { type: 'score', keywords: { 2: ['receipt'] } },
      needsHuman: { type: 'noul', keywords: ['insaan', 'lawyer'] },
    },
  });

  it('answers deterministically from keyword rules, with no confidence for noul', async () => {
    const request = {
      task: 'handoff-advisory',
      rubricVersion: 'handoff-v1',
      language: 'roman-urdu',
      state: { message: 'Mujhe do baar CHARGED kiya, receipt hai. Insaan se baat karni hai.' },
      questions,
    } as const;
    const first = await mock.decide(request);
    expect(first).toEqual(await mock.decide(request));
    expect(first).toMatchObject({
      status: 'decided',
      provider: 'mock',
      modelVersion: 'decision-mock-1',
      language: 'roman-urdu',
      latencyMs: 0,
    });
    if (first.status !== 'decided') return;
    expect(first.value.intent).toMatchObject({ label: 'billing', confidence: 0.9 });
    expect(first.value.evidence).toMatchObject({ score: 1.85, confidence: 0.9 });
    expect(first.value.needsHuman).toEqual({ type: 'noul', probability: 0.9 });
    expect(first.usage?.outputTokens).toBe(3);
  });

  it('falls back to other/unknown labels with low confidence when nothing matches', async () => {
    const result = await mock.decide({
      task: 'triage',
      rubricVersion: 'v1',
      state: 'hello there',
      questions: { intent: questions.intent, needsHuman: questions.needsHuman },
    });
    expect(result.status === 'decided' && result.value.intent).toMatchObject({
      label: 'other',
      confidence: 0.4,
    });
    expect(result.status === 'decided' && result.value.needsHuman.probability).toBe(0.1);
  });

  it('reports invalid requests, mismatched rules and cancellation as statuses', async () => {
    expect(
      await mock.decide({ task: 't', rubricVersion: 'v1', state: null, questions: {} }),
    ).toMatchObject({ status: 'invalid', reason: 'at least one question is required' });
    expect(
      await mock.decide({
        task: 't',
        rubricVersion: 'v1',
        state: null,
        questions: { intent: questions.needsHuman },
      }),
    ).toMatchObject({
      status: 'invalid',
      reason: 'question "intent": a choice rule cannot answer a noul',
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await mock.decide({
        task: 't',
        rubricVersion: 'v1',
        state: null,
        questions,
        signal: controller.signal,
      }),
    ).toMatchObject({ status: 'unavailable', retryable: false, reason: 'aborted' });
  });

  it('feeds applyThreshold like any provider', async () => {
    const result = await mock.decide({
      task: 'handoff-advisory',
      rubricVersion: 'handoff-v1',
      language: 'en',
      state: 'I need a lawyer about my parcel and I have the receipt',
      questions,
    });
    const gated = applyThreshold(
      result,
      policyFor(EN, { provider: 'mock', modelVersion: 'decision-mock-1' }),
    );
    expect(gated).toMatchObject({ status: 'decided' });
    expect(gated.status === 'decided' && gated.value.needsHuman.verdict).toBe(true);
  });
});
