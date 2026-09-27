import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capabilitiesOf,
  createEmbeddingModel,
  createLanguageModel,
  ModelCapabilityError,
  ModelConfigError,
  type ModelSpec,
  normalizeModelError,
  PROVIDER_CAPABILITIES,
} from '../../src/models/index.js';
import { interceptProviders, json } from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();

afterEach(() => {
  vi.unstubAllEnvs();
});

const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw');
};

describe('createLanguageModel', () => {
  it.each([
    ['anthropic', 'anthropic.messages'],
    ['openai', 'openai.chat'],
    ['google', 'google.generative-ai'],
    ['openai-compatible', 'ollama.chat'],
  ])('builds a %s model', (provider, id) => {
    const kit = KITS.find((candidate) => candidate.provider === provider)!;
    const model = createLanguageModel(kit.spec);
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe(id);
    expect(model.modelId).toBe(kit.spec.modelId);
  });

  it('builds the deterministic mock', async () => {
    const model = createLanguageModel({ provider: 'mock', modelId: 'hamnivo-mock' });
    const { text } = await generateText({ model, prompt: 'Assalamu alaikum' });
    expect(model.provider).toBe('hamnivo');
    expect(text).toMatch(/^Wa alaikum assalam! /);
  });

  it('needs an API key for first-party providers and never takes one from the environment', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-env');
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-env');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'AIza-from-env');
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const error = thrown(() => createLanguageModel({ provider, modelId: 'any' }));
      expect(error).toBeInstanceOf(ModelConfigError);
      expect(error).toMatchObject({ field: 'apiKey' });
      expect(normalizeModelError(error)).toMatchObject({ kind: 'auth', retryable: false });
    }
    expect(() => createEmbeddingModel({ provider: 'openai', modelId: 'x', apiKey: '' })).toThrow(
      ModelConfigError,
    );
  });

  it('sends requests to the public API even when base URL variables are set', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://env.example.test/anthropic');
    vi.stubEnv('OPENAI_BASE_URL', 'https://env.example.test/openai');
    const anthropic = KITS.find((kit) => kit.provider === 'anthropic')!;
    const openai = KITS.find((kit) => kit.provider === 'openai')!;
    const requests = http.reply((request) =>
      new URL(request.url).hostname === 'api.anthropic.com'
        ? json(anthropic.fixtures.generate)(request, 0)
        : json(openai.fixtures.generate)(request, 0),
    );
    await createLanguageModel(anthropic.spec).doGenerate({ prompt: PROMPT });
    await createLanguageModel(openai.spec).doGenerate({ prompt: PROMPT });
    expect(requests.map((request) => request.url.href)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.openai.com/v1/chat/completions',
    ]);
  });

  it('uses the base URL, headers and fetch from the spec', async () => {
    const kit = KITS.find((candidate) => candidate.provider === 'anthropic')!;
    const requests = http.reply(json(kit.fixtures.generate));
    const fetch = vi.fn(globalThis.fetch);
    const spec: ModelSpec = {
      ...kit.spec,
      baseURL: 'https://gateway.example.test/anthropic/v1',
      headers: { 'x-hamnivo-tenant': 'ten_1' },
      fetch,
    };
    await createLanguageModel(spec).doGenerate({ prompt: PROMPT });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests[0]?.url.href).toBe('https://gateway.example.test/anthropic/v1/messages');
    expect(requests[0]?.headers.get('x-hamnivo-tenant')).toBe('ten_1');
  });

  it('rejects a provider it does not know', () => {
    const spec = { provider: 'cohere', modelId: 'command' } as unknown as ModelSpec;
    expect(thrown(() => createLanguageModel(spec))).toMatchObject({ field: 'provider' });
    expect(() => createEmbeddingModel(spec)).toThrow(ModelConfigError);
    expect(() => capabilitiesOf(spec)).toThrow('Unknown model provider');
  });
});

describe('createEmbeddingModel', () => {
  it.each([
    ['openai', 'openai.embedding'],
    ['google', 'google.generative-ai'],
    ['openai-compatible', 'ollama.embedding'],
    ['mock', 'hamnivo'],
  ])('builds a %s embedding model', (provider, id) => {
    const kit = KITS.find((candidate) => candidate.provider === provider);
    const spec = kit
      ? { ...kit.spec, modelId: 'embedder' }
      : { provider: 'mock' as const, modelId: 'embedder' };
    const model = createEmbeddingModel(spec);
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe(id);
    expect(model.modelId).toBe('embedder');
  });

  it('throws ModelCapabilityError for anthropic', () => {
    const kit = KITS.find((candidate) => candidate.provider === 'anthropic')!;
    expect(thrown(() => createEmbeddingModel(kit.spec))).toBeInstanceOf(ModelCapabilityError);
  });
});

describe('capabilitiesOf', () => {
  it('reads the provider table', () => {
    expect(capabilitiesOf({ provider: 'openai' })).toEqual(PROVIDER_CAPABILITIES.openai);
    expect(capabilitiesOf({ provider: 'google' }).embeddings).toBe(true);
    expect(capabilitiesOf({ provider: 'mock' })).toEqual({
      streaming: true,
      toolCalls: false,
      structuredOutput: false,
      embeddings: true,
      imageInput: false,
    });
  });

  it('lets a spec narrow a first-party provider but not widen it', () => {
    expect(
      capabilitiesOf({ provider: 'openai', capabilities: { imageInput: false, toolCalls: false } }),
    ).toMatchObject({ imageInput: false, toolCalls: false, streaming: true });
    expect(capabilitiesOf({ provider: 'mock', capabilities: { toolCalls: true } }).toolCalls).toBe(
      false,
    );
  });

  it('ignores declarations that are not capabilities', () => {
    const spec = {
      provider: 'openai-compatible',
      capabilities: { telepathy: true, toolCalls: 'yes' },
    } as unknown as ModelSpec;
    expect(capabilitiesOf(spec)).toEqual(PROVIDER_CAPABILITIES['openai-compatible']);
  });

  it('keeps the table frozen', () => {
    expect(Object.isFrozen(PROVIDER_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CAPABILITIES.anthropic)).toBe(true);
  });
});
