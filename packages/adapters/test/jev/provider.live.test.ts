/**
 * Live verification of the Jev adapter against TypeSafe's API (opt-in: `pnpm test:live`). The key
 * comes from TYPESAFE_API_KEY and is never printed; without it this file is skipped. Every call is
 * pinned to jev-1.13.0, the version Hamnivo's thresholds were evaluated on.
 */
import type { DecisionQuestions } from '@hamnivo/domain';
import { describe, expect, it } from 'vitest';
import { createJevDecisionProvider } from '../../src/jev/index.js';

const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? '';
const baseURL = process.env.TYPESAFE_BASE_URL?.trim() || undefined;
const MODEL = 'jev-1.13.0';
/** The chat path's budget for one decision. */
const DEADLINE_MS = 1500;

const sum = (values: Record<string, number | undefined>) =>
  Object.values(values).reduce<number>((total, p) => total + (p ?? 0), 0);

const routing = {
  intent: {
    type: 'choice',
    instructions: 'Which of these topics is the customer asking about?',
    labels: {
      billing: 'Payments, invoices and refunds',
      shipping: 'Delivery and parcels',
      other: 'None of these, or not clear from the messages',
    },
  },
  frustration: {
    type: 'score',
    instructions: 'How frustrated does the customer appear in their messages?',
    rubric: ['Calm and matter-of-fact', 'Frustrated but civil', 'Very angry'],
  },
} as const satisfies DecisionQuestions;

const handoff = {
  wantsPerson: {
    type: 'noul',
    instructions: 'Is the customer asking to talk to a human person instead of the AI assistant?',
    outcomes: {
      true: 'The customer asks for a person, an agent or a human',
      false: 'The customer does not ask for a person',
    },
  },
  mentionsRefund: {
    type: 'noul',
    instructions: 'Does the customer ask for a refund?',
  },
} as const satisfies DecisionQuestions;

function jev(key = apiKey, deadlineMs = DEADLINE_MS) {
  return createJevDecisionProvider({
    apiKey: key,
    model: MODEL,
    deadlineMs,
    ...(baseURL ? { baseURL } : {}),
  });
}

describe.skipIf(apiKey === '')('Jev live (jev-1.13.0)', () => {
  it('maps a choice and a score, with usage, latency and the pinned model recorded', async () => {
    const result = await jev().decide({
      task: 'live-verification',
      rubricVersion: 'live-1',
      language: 'en',
      state: {
        messages: [
          'This is the third time I am writing. My parcel was due on Monday and it still has not arrived. Where is it?!',
        ],
      },
      questions: routing,
    });
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`);
    expect(result.modelVersion).toBe(MODEL);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.latencyMs).toBeLessThanOrEqual(DEADLINE_MS);
    expect(result.requestId).toEqual(expect.any(String));

    const { intent, frustration } = result.value;
    expect(intent.type).toBe('choice');
    expect(intent.label).toBe('shipping');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.5);
    expect(intent.confidence).toBeLessThanOrEqual(1);
    expect(Object.keys(intent.probabilities).sort()).toEqual(['billing', 'other', 'shipping']);
    expect(sum(intent.probabilities)).toBeCloseTo(1, 1);

    expect(frustration.type).toBe('score');
    expect(frustration.score).toBeGreaterThanOrEqual(1);
    expect(frustration.score).toBeLessThanOrEqual(2);
    expect(Object.keys(frustration.probabilities).sort()).toEqual(['0', '1', '2']);
    expect(sum(frustration.probabilities)).toBeCloseTo(1, 1);
  });

  it('maps nouls to probabilities, with no confidence invented for them', async () => {
    const result = await jev().decide({
      task: 'live-verification',
      rubricVersion: 'live-1',
      language: 'roman-urdu',
      state: { messages: ['Mujhe kisi banday se baat karni hai, bot se nahi'] },
      questions: handoff,
    });
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`);
    expect(result.value.wantsPerson).toEqual({ type: 'noul', probability: expect.any(Number) });
    expect(result.value.wantsPerson.probability).toBeGreaterThanOrEqual(0.8);
    expect(result.value.mentionsRefund.probability).toBeLessThanOrEqual(0.3);
    expect(result.value.wantsPerson).not.toHaveProperty('confidence');
  });

  it('stops a call at its deadline and reports it as unavailable', async () => {
    const started = performance.now();
    const result = await jev(apiKey, 25).decide({
      task: 'live-verification',
      rubricVersion: 'live-1',
      state: { messages: ['Where is my parcel?'] },
      questions: { intent: routing.intent },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'deadline', retryable: true });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('reports a wrong key as unavailable (auth), never as a decision', async () => {
    const result = await jev('ts-wrong-key-for-hamnivo-live-tests').decide({
      task: 'live-verification',
      rubricVersion: 'live-1',
      state: { messages: ['Where is my parcel?'] },
      questions: { intent: routing.intent },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'auth', retryable: false });
  });

  it('reports a call the caller cancelled as aborted', async () => {
    const controller = new AbortController();
    const pending = jev().decide({
      task: 'live-verification',
      rubricVersion: 'live-1',
      state: { messages: ['Where is my parcel?'] },
      questions: { intent: routing.intent },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result).toMatchObject({ status: 'unavailable', reason: 'aborted', retryable: false });
    expect(result.latencyMs).toBeLessThan(500);
  });
});
