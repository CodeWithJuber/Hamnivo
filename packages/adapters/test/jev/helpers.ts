import { readFileSync } from 'node:fs';
import type { DecisionQuestions } from '@hamnivo/domain';
import { createJevDecisionProvider, type JevDecisionProviderOptions } from '../../src/jev/index.js';

export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

export const questions = {
  intent: {
    type: 'choice',
    instructions: 'What is the customer asking about?',
    labels: {
      billing: 'Payments, refunds and invoices',
      delivery: 'Shipping and delivery',
      other: null,
    },
  },
  evidence: {
    type: 'score',
    instructions: 'How well do the order notes support an answer?',
    rubric: ['No support', 'Partial support', 'Full support'],
  },
  needsHuman: {
    type: 'noul',
    instructions: 'The customer needs a person to resolve this.',
    outcomes: { true: 'Only a person can resolve it', false: 'The assistant can continue' },
  },
} as const satisfies DecisionQuestions;

export const request = {
  task: 'handoff-advisory',
  rubricVersion: 'handoff-v1',
  language: 'hinglish',
  state: {
    message: 'Order HV-10293 pay ho gaya, delivery nahi mili. شکریہ',
    orderRef: 'HV-10293',
    orderStatus: 'paid',
  },
  questions,
} as const;

export interface Reply {
  status?: number;
  /** An object is sent as JSON, a string as is. Default: the success fixture. */
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** A transport that ignores cancellation, to show the adapter enforces the deadline itself. */
  ignoreAbort?: boolean;
  networkError?: boolean;
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** A `fetch` that answers from fixtures, in order (the last reply repeats), and records calls. */
export function fakeJev(...replies: Reply[]) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const reply = replies[Math.min(calls.length, replies.length) - 1] ?? {};
    if (reply.delayMs) await wait(reply.delayMs, reply.ignoreAbort ? null : init?.signal);
    if (reply.networkError) throw new TypeError('fetch failed');
    const body = reply.body === undefined ? fixture('systemone-response.json') : reply.body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: reply.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'x-typesafe-request-id': `req_${calls.length}`,
        ...reply.headers,
      },
    });
  };
  return { fetch, calls };
}

export const jevWith = (
  fetch: JevDecisionProviderOptions['fetch'],
  options: Partial<JevDecisionProviderOptions> = {},
) => createJevDecisionProvider({ apiKey: 'test-key', model: 'jev-1.13.0', fetch, ...options });
