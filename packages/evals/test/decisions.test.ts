import { createMockDecisionProvider, LANGUAGE_SLICES } from '@hamnivo/domain';
import { describe, expect, it } from 'vitest';
import {
  atNoulBand,
  brierBinary,
  brierChoice,
  chooseChoiceThreshold,
  chooseNoulBand,
  expectedCalibrationError,
  percentile,
} from '../src/calibration.js';
import {
  decisionItems,
  loadRoutingCorpus,
  routingCorpusProblems,
  runDecisions,
  scoreDecisions,
} from '../src/decisions.js';
import { decisionsMarkdown } from '../src/decisions-report.js';

describe('routing corpus for decision evaluation (J02, U01)', () => {
  it('has about 40 labelled messages per language slice, every topic in each', () => {
    const corpus = loadRoutingCorpus();
    expect(routingCorpusProblems(corpus)).toEqual([]);
    expect(corpus.review).toBe('pending_native_review');
    for (const slice of LANGUAGE_SLICES) {
      expect(corpus.items.filter((i) => i.slice === slice).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('adds the hand-off fixtures and the U13 pairs, each with only the labels it has', () => {
    const items = decisionItems();
    const handoff = items.filter((i) => i.source === 'handoff');
    expect(handoff.length).toBeGreaterThanOrEqual(100);
    expect(handoff.every((i) => i.wantsPerson !== undefined && i.language === undefined)).toBe(
      true,
    );
    const pairs = items.filter((i) => i.source === 'fairness');
    expect(pairs.length).toBeGreaterThanOrEqual(30);
    expect(pairs.every((i) => i.group && i.language)).toBe(true);
  });
});

describe('scores for probabilistic decisions', () => {
  it('Brier: 0 when certain and right, 2 when certain and wrong', () => {
    expect(brierChoice([{ probabilities: { a: 1, b: 0 }, truth: 'a' }])).toBe(0);
    expect(brierChoice([{ probabilities: { a: 1, b: 0 }, truth: 'b' }])).toBe(2);
    expect(brierChoice([{ probabilities: { a: 0.5, b: 0.5 }, truth: 'a' }])).toBe(0.5);
    expect(
      brierBinary([
        { p: 0.9, y: true },
        { p: 0.2, y: false },
      ]),
    ).toBe(0.025);
    expect(brierChoice([])).toBeNull();
  });

  it('calibration error compares stated confidence with how often it was right', () => {
    // Said 0.9 ten times and was right nine times: perfectly calibrated.
    const calibrated = Array.from({ length: 10 }, (_, i) => ({ score: 0.9, outcome: i < 9 }));
    expect(expectedCalibrationError(calibrated)).toBe(0);
    // Said 0.9 and was always wrong.
    expect(expectedCalibrationError([{ score: 0.9, outcome: false }])).toBe(0.9);
  });

  it('percentiles by nearest rank', () => {
    expect(percentile([300, 100, 200, 400], 50)).toBe(200);
    expect(percentile([300, 100, 200, 400], 95)).toBe(400);
    expect(percentile([], 50)).toBeNull();
  });

  it('chooses the lowest threshold that keeps decided answers at least 90% right', () => {
    const answers = [
      ...Array.from({ length: 9 }, () => ({ confidence: 0.92, correct: true })),
      { confidence: 0.6, correct: false },
      { confidence: 0.55, correct: true },
    ];
    expect(chooseChoiceThreshold(answers)).toMatchObject({
      minConfidence: 0.3,
      decided: 11,
      accuracy: 0.9091,
    });
    const shaky = [
      ...Array.from({ length: 6 }, () => ({ confidence: 0.95, correct: true })),
      ...Array.from({ length: 4 }, () => ({ confidence: 0.6, correct: false })),
    ];
    expect(chooseChoiceThreshold(shaky)).toMatchObject({ minConfidence: 0.65, decided: 6 });
    expect(chooseChoiceThreshold([{ confidence: 0.9, correct: false }])).toBeNull();
  });

  it('chooses a noul band with precise "true" answers, abstaining in between', () => {
    const answers = [
      ...Array.from({ length: 5 }, () => ({ p: 0.97, y: true })),
      { p: 0.6, y: false },
      ...Array.from({ length: 10 }, () => ({ p: 0.05, y: false })),
    ];
    const band = chooseNoulBand(answers);
    expect(band).toMatchObject({ trueAtLeast: 0.65, falseAtMost: 0.5, precision: 1 });
    expect(atNoulBand(answers, 0.65, 0.1)).toMatchObject({ decided: 15, abstention: 0.0625 });
    expect(chooseNoulBand([{ p: 0.9, y: false }])).toBeNull();
  });
});

describe('the decisions suite with the mock provider (no network)', () => {
  const items = decisionItems().filter((_, index) => index % 12 === 0);

  it('asks each message once with the product’s questions and scores every task', async () => {
    const provider = createMockDecisionProvider({
      rules: { intent: { type: 'choice', keywords: { shipping: ['parcel', 'courier'] } } },
    });
    const { records, calls } = await runDecisions(items, {
      provider,
      model: 'decision-mock-1',
      concurrency: 3,
    });
    expect(calls).toBe(items.length);
    expect(records.every((r) => r.status === 'decided')).toBe(true);
    const report = scoreDecisions(items, records, {
      provider: 'mock',
      model: 'decision-mock-1',
      calls,
    });
    expect(report.personRequest.overall.items).toBeGreaterThan(0);
    expect(report.routing.overall.items).toBeGreaterThan(0);
    expect(report.language.overall.items).toBeGreaterThan(0);
    expect(report.tokens.input).toBeGreaterThan(0);
    const markdown = decisionsMarkdown(report, {
      date: '2026-10-02',
      command: 'run-suite decisions --provider mock',
      concurrency: 3,
      deadlineMs: 5000,
      corpusSizes: { sample: items.length },
      rubric: loadRoutingCorpus().rubric,
    });
    expect(markdown).toContain('### Request for a person');
    expect(markdown).toContain('### Routing intent');
    expect(markdown).not.toMatch(/TYPESAFE_API_KEY=\S/);
  });

  it('refuses a run that would need more calls than allowed, before calling anyone', async () => {
    let asked = 0;
    const provider = createMockDecisionProvider();
    const counting = {
      id: provider.id,
      decide: ((request) => {
        asked += 1;
        return provider.decide(request);
      }) as typeof provider.decide,
    };
    await expect(
      runDecisions(items, { provider: counting, model: 'm', maxCalls: items.length - 1 }),
    ).rejects.toThrow(/more than the/);
    expect(asked).toBe(0);
  });

  it('retries a failed call within the cap and reports what stayed unanswered', async () => {
    let failures = 0;
    const flaky = {
      id: 'flaky',
      decide: (async (request) => {
        failures += 1;
        return {
          provider: 'flaky',
          task: request.task,
          rubricVersion: request.rubricVersion,
          latencyMs: 1,
          status: 'unavailable',
          retryable: true,
          reason: 'rate_limited',
        };
      }) as ReturnType<typeof createMockDecisionProvider>['decide'],
    };
    const few = items.slice(0, 2);
    const { records, calls } = await runDecisions(few, {
      provider: flaky,
      model: 'm',
      retries: 1,
      maxCalls: 10,
    });
    expect(calls).toBe(4);
    expect(failures).toBe(4);
    const report = scoreDecisions(few, records, { provider: 'flaky', model: 'm', calls });
    expect(report.failures).toEqual({ 'unavailable:rate_limited': 2 });
  }, 10_000);
});
