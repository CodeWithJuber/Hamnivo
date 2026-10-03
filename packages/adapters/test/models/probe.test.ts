import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  classifyProbeError,
  PROBE_MAX_OUTPUT_TOKENS,
  type ProbeKind,
  probeModel,
} from '../../src/models/index.js';
import { fixtureJson, interceptProviders, json, type Responder } from './harness.js';
import { KITS, type ProviderKit } from './kits.js';

/**
 * The test call behind "Test this key" in Studio: one real request of a few tokens, and a plain
 * answer to "is my key good?": wrong key, no credit, unknown model, cannot reach the provider.
 * Every provider is faked at its own address and in its own error shapes.
 */

const http = interceptProviders();
const kit = (provider: ProviderKit['provider']) =>
  KITS.find((candidate) => candidate.provider === provider) as ProviderKit;

const wait =
  (ms: number): Responder =>
  async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return HttpResponse.json({}, { status: 200 });
  };

async function probe(provider: ProviderKit['provider'], respond: Responder) {
  const captured = http.reply(respond);
  const result = await probeModel(kit(provider).spec);
  return { result, captured };
}

describe('a key that works', () => {
  for (const { provider } of KITS) {
    it(`${provider}: one small request, answered`, async () => {
      const { result, captured } = await probe(provider, json(kit(provider).fixtures.generate));
      expect(result).toMatchObject({ ok: true, kind: 'ok' });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      // One request, no retries, and only a few tokens asked for.
      expect(captured).toHaveLength(1);
      kit(provider).assertAuth(captured[0] as never);
      const body = captured[0]?.body ?? {};
      const limit =
        body.max_tokens ?? body.max_completion_tokens ?? body.generationConfig?.maxOutputTokens;
      expect(limit).toBe(PROBE_MAX_OUTPUT_TOKENS);
    });
  }
});

describe('a key the provider does not accept', () => {
  it.each(['anthropic', 'openai', 'google', 'openai-compatible'] as const)(
    '%s: a 401 is a wrong key',
    async (provider) => {
      const { result, captured } = await probe(
        provider,
        json(kit(provider).fixtures.errors[401], 401),
      );
      expect(result).toMatchObject({ ok: false, kind: 'wrong_key', status: 401 });
      expect(captured).toHaveLength(1);
    },
  );

  it('gemini answers a bad key with a 400 and API_KEY_INVALID', async () => {
    const { result } = await probe(
      'google',
      json(fixtureJson('google', 'api-key-invalid.json'), 400),
    );
    expect(result).toMatchObject({ ok: false, kind: 'wrong_key', status: 400 });
  });

  it('a 403 permission error is a key that is not allowed to do this', async () => {
    const body = { type: 'error', error: { type: 'permission_error', message: 'Not allowed' } };
    const { result } = await probe('anthropic', json(body, 403));
    expect(result.kind).toBe('wrong_key');
  });

  it('a missing key is a wrong key, found before any request is made', async () => {
    const captured = http.reply(json({}));
    const { apiKey: _key, ...withoutKey } = kit('openai').spec;
    expect(await probeModel(withoutKey)).toMatchObject({ ok: false, kind: 'wrong_key' });
    expect(captured).toHaveLength(0);
  });
});

describe('an account with no credit', () => {
  it('openai: a 429 with insufficient_quota is not a rate limit', async () => {
    const body = {
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        param: null,
        code: 'insufficient_quota',
      },
    };
    const { result, captured } = await probe('openai', json(body, 429));
    expect(result).toMatchObject({ ok: false, kind: 'no_credit', status: 429 });
    expect(captured).toHaveLength(1);
  });

  it('anthropic: a 400 that says the credit balance is too low', async () => {
    const body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    };
    const { result } = await probe('anthropic', json(body, 400));
    expect(result).toMatchObject({ ok: false, kind: 'no_credit', status: 400 });
  });

  it('a 402 is no credit, not a wrong key', async () => {
    const body = { type: 'error', error: { type: 'billing_error', message: 'Payment required' } };
    const { result } = await probe('anthropic', json(body, 402));
    expect(result.kind).toBe('no_credit');
  });

  it('gemini: a drained quota is no credit, but a quota that says when to retry is only a limit', async () => {
    const drained = {
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
      },
    };
    expect((await probe('google', json(drained, 429))).result.kind).toBe('no_credit');
    const limited = fixtureJson('google', 'errors.json')['429'];
    expect((await probe('google', json(limited, 429))).result.kind).toBe('rate_limited');
  });

  it('a plain rate limit is a rate limit', async () => {
    const { result } = await probe('openai', json(kit('openai').fixtures.errors[429], 429));
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited', status: 429 });
  });
});

describe('a model the provider does not know', () => {
  const cases: [ProviderKit['provider'], unknown][] = [
    [
      'openai',
      {
        error: {
          message: 'The model `gpt-9` does not exist or you do not have access to it.',
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_found',
        },
      },
    ],
    [
      'anthropic',
      { type: 'error', error: { type: 'not_found_error', message: 'model: claude-9' } },
    ],
    [
      'google',
      {
        error: {
          code: 404,
          message:
            'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.',
          status: 'NOT_FOUND',
        },
      },
    ],
    [
      'openai-compatible',
      { error: { message: 'model "qwen9" not found, try pulling it first', type: 'api_error' } },
    ],
  ];
  it.each(cases)('%s: a 404 is an unknown model', async (provider, body) => {
    const { result } = await probe(provider, json(body, 404));
    expect(result).toMatchObject({ ok: false, kind: 'model_not_found', status: 404 });
  });

  it('a 400 that says the model is invalid is an unknown model too', async () => {
    const body = { error: { message: 'invalid model ID', type: 'invalid_request_error' } };
    expect((await probe('openai', json(body, 400))).result.kind).toBe('model_not_found');
  });
});

describe('a provider that cannot be reached or is in trouble', () => {
  it('a connection that fails is a network problem', async () => {
    http.reply(() => HttpResponse.error());
    const result = await probeModel(kit('openai').spec);
    expect(result).toMatchObject({ ok: false, kind: 'network' });
    expect(result.status).toBeUndefined();
  });

  it('a call that takes too long is given up on, as a network problem', async () => {
    http.reply(wait(2000));
    const result = await probeModel(kit('anthropic').spec, { timeoutMs: 40 });
    expect(result).toMatchObject({ ok: false, kind: 'network' });
    expect(result.latencyMs).toBeLessThan(1500);
  });

  it('a 5xx is the provider’s own trouble, and is not retried', async () => {
    for (const status of [500, 503, 529] as const) {
      const captured = http.reply(json(kit('anthropic').fixtures.errors[status], status));
      const result = await probeModel(kit('anthropic').spec);
      expect(result, String(status)).toMatchObject({ ok: false, kind: 'unavailable', status });
      expect(captured, String(status)).toHaveLength(1);
    }
  });

  it('an address the egress guard refuses is "blocked", not a network problem', async () => {
    const refusal = (problem: string) =>
      Object.assign(new Error('The address points to a private network.'), {
        name: 'EgressError',
        problem,
      });
    const refused = (problem: string) => async () => {
      throw refusal(problem);
    };
    for (const [problem, kind] of [
      ['private_address', 'blocked'],
      ['host_not_allowed', 'blocked'],
      ['insecure_url', 'blocked'],
      ['redirect', 'blocked'],
      ['timeout', 'network'],
      ['network', 'network'],
      ['unresolvable', 'network'],
    ] as [string, ProbeKind][]) {
      const result = await probeModel({
        ...kit('openai-compatible').spec,
        fetch: refused(problem) as never,
      });
      expect(result, problem).toMatchObject({ ok: false, kind });
    }
    // fetch wraps what the connection guard throws in a TypeError that carries it as its cause.
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: refusal('private_address'),
    });
    expect(classifyProbeError(wrapped)).toBe('blocked');
  });

  it('says nothing it was told in confidence: neither the key nor the provider’s own words', async () => {
    const secret = kit('openai').key;
    http.reply(
      json(
        { error: { message: `Incorrect API key provided: ${secret}`, code: 'invalid_api_key' } },
        401,
      ),
    );
    const result = await probeModel(kit('openai').spec);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.keys(result).sort()).toEqual(['kind', 'latencyMs', 'ok', 'status']);
  });
});
