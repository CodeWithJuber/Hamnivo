import { HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { LIST_MAX_MODELS, type ListSpec, listModels } from '../../src/models/index.js';
import { interceptProviders, json, type Responder } from './harness.js';

/**
 * The live model list behind Studio's model field: one GET to the provider's own list, read into
 * one shape, chat models only. Shapes from https://platform.claude.com/docs/en/api/models/list,
 * https://platform.openai.com/docs/api-reference/models/list and https://ai.google.dev/api/models.
 */

const http = interceptProviders();

/** Fake keys: no provider is reached, every request is answered by msw. */
const KEYS = {
  anthropic: 'test-anthropic-key',
  openai: 'test-openai-key',
  google: 'test-google-key',
  compatible: 'test-server-key',
};

const SPECS: Record<ListSpec['provider'], ListSpec> = {
  anthropic: { provider: 'anthropic', apiKey: KEYS.anthropic },
  openai: { provider: 'openai', apiKey: KEYS.openai },
  google: { provider: 'google', apiKey: KEYS.google },
  'openai-compatible': {
    provider: 'openai-compatible',
    apiKey: KEYS.compatible,
    baseURL: 'https://llm.example.com/v1/',
  },
};

const ANTHROPIC = {
  data: [
    {
      type: 'model',
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      lifecycle: 'active',
      created_at: '2026-09-21T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      lifecycle: 'deprecated',
      created_at: '2025-10-01T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-haiku-5-5',
      display_name: 'Claude Haiku 5.5',
      lifecycle: 'active',
      created_at: '2026-09-01T00:00:00Z',
    },
    { type: 'model', id: 'claude-2.1', display_name: 'Claude 2.1', lifecycle: 'retired' },
  ],
  has_more: false,
  first_id: 'claude-opus-5-5',
  last_id: 'claude-2.1',
};

const OPENAI = {
  object: 'list',
  data: [
    { id: 'gpt-5.4-mini', object: 'model', created: 1_780_000_000, owned_by: 'openai' },
    { id: 'text-embedding-3-small', object: 'model', created: 1_705_000_000, owned_by: 'system' },
    { id: 'gpt-5.5', object: 'model', created: 1_790_000_000, owned_by: 'openai' },
    { id: 'whisper-1', object: 'model', created: 1_677_000_000, owned_by: 'openai-internal' },
    { id: 'gpt-4o-mini-tts', object: 'model', created: 1_742_000_000, owned_by: 'system' },
    { id: 'dall-e-3', object: 'model', created: 1_698_000_000, owned_by: 'system' },
    { id: 'gpt-image-1', object: 'model', created: 1_745_000_000, owned_by: 'system' },
    { id: 'omni-moderation-latest', object: 'model', created: 1_731_000_000, owned_by: 'system' },
    { id: 'gpt-realtime', object: 'model', created: 1_756_000_000, owned_by: 'system' },
    { id: 'gpt-5-codex', object: 'model', created: 1_757_000_000, owned_by: 'system' },
    { id: 'davinci-002', object: 'model', created: 1_692_000_000, owned_by: 'system' },
    { id: 'gpt-5.4', object: 'model', created: 1_780_000_000, owned_by: 'openai' },
  ],
};

const GOOGLE = {
  models: [
    {
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-embedding-001',
      displayName: 'Gemini Embedding 001',
      supportedGenerationMethods: ['embedContent'],
    },
    {
      name: 'models/gemini-2.5-flash-preview-tts',
      displayName: 'Gemini 2.5 Flash Preview TTS',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
  ],
};

const COMPATIBLE = {
  object: 'list',
  data: [
    { id: 'qwen3:8b', object: 'model', created: 0, owned_by: 'library' },
    { id: 'nomic-embed-text:latest', object: 'model', created: 0, owned_by: 'library' },
    { id: 'llama4:latest', object: 'model', created: 0, owned_by: 'library' },
  ],
};

describe('a key that can list', () => {
  it('anthropic: one GET with the key in x-api-key; retired left out, deprecated last', async () => {
    const captured = http.reply(json(ANTHROPIC));
    const result = await listModels(SPECS.anthropic);
    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.href).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(request?.headers.get('x-api-key')).toBe(KEYS.anthropic);
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', deprecated: false },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', deprecated: false },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', deprecated: true },
      ],
    });
  });

  it('openai: chat models only, newest first', async () => {
    const captured = http.reply(json(OPENAI));
    const result = await listModels(SPECS.openai);
    expect(captured[0]?.url.href).toBe('https://api.openai.com/v1/models');
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${KEYS.openai}`);
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'gpt-5.5', name: null, deprecated: false },
        { id: 'gpt-5.4', name: null, deprecated: false },
        { id: 'gpt-5.4-mini', name: null, deprecated: false },
      ],
    });
  });

  it('google: generateContent models without the models/ prefix, key in a header', async () => {
    const captured = http.reply(json(GOOGLE));
    const result = await listModels(SPECS.google);
    const request = captured[0];
    expect(`${request?.url.origin}${request?.url.pathname}`).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
    expect(request?.headers.get('x-goog-api-key')).toBe(KEYS.google);
    // Never in the address, where proxies and access logs would keep it.
    expect(request?.url.searchParams.has('key')).toBe(false);
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', deprecated: false },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', deprecated: false },
      ],
    });
  });

  it('openai-compatible: the server’s own /models, sorted by name, embeddings left out', async () => {
    const captured = http.reply(json(COMPATIBLE));
    const result = await listModels(SPECS['openai-compatible']);
    expect(captured[0]?.url.href).toBe('https://llm.example.com/v1/models');
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${KEYS.compatible}`);
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'llama4:latest', name: null, deprecated: false },
        { id: 'qwen3:8b', name: null, deprecated: false },
      ],
    });
  });

  it('openai-compatible without a key sends no authorization header', async () => {
    const captured = http.reply(json(COMPATIBLE));
    await listModels({ provider: 'openai-compatible', baseURL: 'https://llm.example.com/v1' });
    expect(captured[0]?.headers.get('authorization')).toBeNull();
  });

  it('keeps at most LIST_MAX_MODELS, each id once', async () => {
    const data = Array.from({ length: LIST_MAX_MODELS + 20 }, (_, i) => ({
      id: `model-${String(i).padStart(4, '0')}`,
    }));
    http.reply(json({ data: [...data, { id: 'model-0000' }] }));
    const result = await listModels(SPECS['openai-compatible']);
    expect(result.ok && result.models).toHaveLength(LIST_MAX_MODELS);
    expect(result.ok && new Set(result.models.map((m) => m.id)).size).toBe(LIST_MAX_MODELS);
  });
});

describe('a list that cannot be read', () => {
  it.each([
    [
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      'wrong_key',
    ],
    [403, { type: 'error', error: { type: 'permission_error', message: 'no' } }, 'wrong_key'],
    [
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'rate_limited',
    ],
    [500, { type: 'error', error: { type: 'api_error', message: 'oops' } }, 'unavailable'],
    [404, { error: { message: 'Not Found' } }, 'unknown'],
  ] as const)('a %i is %s, with the status kept', async (status, body, kind) => {
    http.reply(json(body, status));
    const result = await listModels(SPECS.anthropic);
    expect(result).toEqual({ ok: false, kind, status });
  });

  it('an account without credit is no_credit', async () => {
    http.reply(
      json(
        {
          error: {
            message: 'You exceeded your current quota.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        429,
      ),
    );
    expect(await listModels(SPECS.openai)).toEqual({ ok: false, kind: 'no_credit', status: 429 });
  });

  it('no answer at all is network', async () => {
    http.reply(() => HttpResponse.error());
    expect(await listModels(SPECS.openai)).toEqual({ ok: false, kind: 'network' });
  });

  it('gives up after the time limit', async () => {
    const slow: Responder = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return HttpResponse.json(OPENAI);
    };
    http.reply(slow);
    expect(await listModels(SPECS.openai, { timeoutMs: 50 })).toEqual({
      ok: false,
      kind: 'network',
    });
  });

  it('an answer that is not a model list is unknown', async () => {
    http.reply(() => new HttpResponse('<html>proxy</html>', { status: 200 }));
    expect(await listModels(SPECS.openai)).toMatchObject({ ok: false, kind: 'unknown' });
    http.reply(json({ hello: 'world' }));
    expect(await listModels(SPECS.openai)).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('a first-party provider without a key asks nothing and says wrong_key', async () => {
    const captured = http.reply(json(OPENAI));
    expect(await listModels({ provider: 'openai' })).toEqual({ ok: false, kind: 'wrong_key' });
    expect(captured).toHaveLength(0);
  });

  it('an OpenAI-compatible server without an address asks nothing', async () => {
    const captured = http.reply(json(OPENAI));
    expect(await listModels({ provider: 'openai-compatible', apiKey: 'k' })).toEqual({
      ok: false,
      kind: 'blocked',
    });
    expect(captured).toHaveLength(0);
  });

  it('never returns the provider’s own words', async () => {
    http.reply(json({ error: { message: 'secret internal detail' } }, 400));
    const result = await listModels(SPECS.openai);
    expect(JSON.stringify(result)).not.toContain('secret internal detail');
  });
});
