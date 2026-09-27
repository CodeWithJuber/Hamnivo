import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevDecisionProvider } from '../../src/jev/index.js';
import { fakeJev, fixture, jevWith, request } from './helpers.js';

type ResponseBody = {
  answers: Record<string, Record<string, unknown>>;
  model?: unknown;
  usage?: unknown;
};

/** The success fixture with a change applied. */
const successWith = (change: (body: ResponseBody) => void) => {
  const body = fixture('systemone-response.json') as ResponseBody;
  change(body);
  return body;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Jev wire contract (E08)', () => {
  it('sends one keyed-map request with the pinned model to the official endpoint', async () => {
    const { fetch, calls } = fakeJev({});
    expect((await jevWith(fetch).decide(request)).status).toBe('decided');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call?.headers.get('authorization')).toBe('Bearer test-key');
    expect(call?.headers.get('x-typesafe-retry-count')).toBeNull();
    expect(call?.body).toEqual(fixture('systemone-request.json'));
    expect(Array.isArray(call?.body.questions)).toBe(false);
  });

  it('ignores the SDK environment fallbacks for endpoint, key, model and logging', async () => {
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://gateway.invalid');
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
    vi.stubEnv('TYPESAFE_DEFAULT_MODEL', 'jev-latest');
    vi.stubEnv('TYPESAFE_LOG_LEVEL', 'debug');
    const { fetch, calls } = fakeJev({});
    await jevWith(fetch).decide(request);
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer test-key');
    expect(calls[0]?.body.model).toBe('jev-1.13.0');
  });

  it('uses a configured base URL', async () => {
    const { fetch, calls } = fakeJev({});
    await jevWith(fetch, { baseURL: 'https://jev.example.test/' }).decide(request);
    expect(calls[0]?.url).toBe('https://jev.example.test/v1/systemone');
  });

  it('refuses moving model aliases, a missing model or key, and a bad deadline', () => {
    const { fetch } = fakeJev({});
    for (const model of ['jev-latest', 'latest', 'jev', ' ']) {
      expect(() => jevWith(fetch, { model })).toThrow(/pinned model version/);
    }
    expect(() => createJevDecisionProvider({ apiKey: '', model: 'jev-1.13.0' })).toThrow(/API key/);
    expect(() => jevWith(fetch, { deadlineMs: 0 })).toThrow(/deadlineMs/);
    expect(() => jevWith(fetch, { breaker: { failureThreshold: 0, cooldownMs: 1 } })).toThrow();
  });
});

describe('Jev answers', () => {
  it('maps choice, score and noul in one keyed request, with audit fields (J07)', async () => {
    let now = 1_000;
    const { fetch } = fakeJev({});
    const slow: typeof fetch = async (url, init) => {
      now += 120;
      return fetch(url, init);
    };
    const result = await jevWith(slow, { clock: () => now }).decide(request);
    expect(result).toEqual({
      status: 'decided',
      provider: 'jev',
      task: 'handoff-advisory',
      rubricVersion: 'handoff-v1',
      language: 'hinglish',
      modelVersion: 'jev-1.13.0',
      usage: { inputTokens: 212, outputTokens: 9 },
      requestId: 'req_1',
      latencyMs: 120,
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
      },
    });
  });

  it('never reports a confidence for noul, even when the wire carries one', async () => {
    const body = successWith((b) => {
      b.answers.needsHuman = { type: 'noul', noul: 0.4, confidence: 0.99 };
    });
    const result = await jevWith(fakeJev({ body }).fetch).decide(request);
    expect(result.status === 'decided' && result.value.needsHuman).toEqual({
      type: 'noul',
      probability: 0.4,
    });
    expect(result).not.toHaveProperty('confidence');
  });
});

describe('invalid answers', () => {
  it.each([
    [
      'a missing answer',
      successWith((b) => {
        delete b.answers.evidence;
      }),
      'no answer for "evidence"',
    ],
    [
      'a label that was not offered',
      successWith((b) => {
        b.answers.intent = { ...b.answers.intent, choice: 'refund' };
      }),
      '"intent": label "refund" was not offered',
    ],
    [
      'an answer of the wrong type',
      successWith((b) => {
        b.answers.intent = { type: 'noul', noul: 0.5 };
      }),
      '"intent": expected a choice answer, got "noul"',
    ],
    [
      'a probability above 1',
      successWith((b) => {
        b.answers.needsHuman = { type: 'noul', noul: 1.2 };
      }),
      '"needsHuman": noul must be a probability from 0 to 1',
    ],
    [
      'a non-finite number',
      JSON.stringify(fixture('systemone-response.json')).replace('"noul":0.12', '"noul":1e999'),
      '"needsHuman": noul must be a probability from 0 to 1',
    ],
    [
      'a confidence given as text',
      successWith((b) => {
        b.answers.intent = { ...b.answers.intent, confidence: '0.82' };
      }),
      '"intent": confidence must be from 0 to 1',
    ],
    [
      'a score outside the rubric',
      successWith((b) => {
        b.answers.evidence = { ...b.answers.evidence, score: 3 };
      }),
      '"evidence": score must be from 0 to 2',
    ],
    [
      'a probability for an option that was not offered',
      successWith((b) => {
        b.answers.intent = { ...b.answers.intent, probabilities: { refund: 0.1 } };
      }),
      '"intent": probability for unknown option "refund"',
    ],
    [
      'answers as an array (the legacy shape)',
      fixture('systemone-legacy-arrays.json'),
      'answers must be a map keyed by question name',
    ],
    [
      'another model version',
      successWith((b) => {
        b.model = 'jev-1.14.0';
      }),
      'from jev-1.14.0, not the pinned jev-1.13.0',
    ],
    [
      'no token usage',
      successWith((b) => {
        delete b.usage;
      }),
      'no valid token usage',
    ],
    ['a body that is not JSON', 'upstream says hello', 'the response is not a JSON object'],
  ])('%s', async (_, body, reason) => {
    const result = await jevWith(fakeJev({ body }).fetch).decide(request);
    expect(result).toMatchObject({ status: 'invalid', provider: 'jev', requestId: 'req_1' });
    expect(result.status === 'invalid' && result.reason).toBe(`Jev answer: ${reason}`);
  });

  it('keeps the model and usage of an invalid answer for cost accounting', async () => {
    const body = successWith((b) => {
      b.answers.intent = { ...b.answers.intent, choice: 'refund' };
    });
    expect(await jevWith(fakeJev({ body }).fetch).decide(request)).toMatchObject({
      status: 'invalid',
      modelVersion: 'jev-1.13.0',
      usage: { inputTokens: 212, outputTokens: 9 },
    });
  });

  it('rejects a malformed request before calling Jev', async () => {
    const { fetch, calls } = fakeJev({});
    const provider = jevWith(fetch);
    expect(await provider.decide({ ...request, questions: {} })).toMatchObject({
      status: 'invalid',
      reason: 'at least one question is required',
    });
    expect(
      await provider.decide({
        ...request,
        questions: { level: { type: 'score', instructions: 'Rate', rubric: ['only'] } },
      } as never),
    ).toMatchObject({
      status: 'invalid',
      reason: 'question "level": the rubric needs at least two levels',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('HTTP errors', () => {
  it.each([400, 422])('%i is invalid: the request itself was refused', async (status) => {
    const { fetch } = fakeJev({
      status,
      body: { detail: [{ loc: ['body', 'state'], msg: 'bad' }] },
    });
    expect(await jevWith(fetch).decide(request)).toMatchObject({
      status: 'invalid',
      reason: `Jev refused the request (HTTP ${status})`,
      requestId: 'req_1',
    });
  });

  it.each([401, 403])('%i is unavailable and not retryable', async (status) => {
    const { fetch } = fakeJev({ status, body: { error: 'nope' } });
    expect(await jevWith(fetch).decide(request)).toMatchObject({
      status: 'unavailable',
      retryable: false,
      reason: 'auth',
    });
  });

  it('429 is retryable, reports Retry-After and is not retried', async () => {
    const { fetch, calls } = fakeJev({
      status: 429,
      body: { error: 'slow down' },
      headers: { 'retry-after': '2' },
    });
    expect(await jevWith(fetch).decide(request)).toMatchObject({
      status: 'unavailable',
      retryable: true,
      reason: 'rate_limited',
      retryAfterMs: 2000,
      requestId: 'req_1',
    });
    expect(calls).toHaveLength(1);
  });

  it('5xx and network failures are retryable and not retried', async () => {
    const server = fakeJev({ status: 500, body: { error: 'boom' } });
    expect(await jevWith(server.fetch).decide(request)).toMatchObject({
      status: 'unavailable',
      retryable: true,
      reason: 'server_error',
    });
    expect(server.calls).toHaveLength(1);
    const network = fakeJev({ networkError: true });
    expect(await jevWith(network.fetch).decide(request)).toMatchObject({
      status: 'unavailable',
      retryable: true,
      reason: 'connection',
    });
    expect(network.calls).toHaveLength(1);
  });

  it('logs nothing: no state, bodies or errors reach the console', async () => {
    vi.stubEnv('TYPESAFE_LOG_LEVEL', 'debug');
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    await jevWith(fakeJev({}).fetch).decide(request);
    await jevWith(fakeJev({ status: 500, body: { error: 'boom' } }).fetch).decide(request);
    await jevWith(fakeJev({ body: 'not json' }).fetch).decide(request);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
