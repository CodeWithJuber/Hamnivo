import {
  APICallError,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  createLanguageModel,
  type FallbackEvent,
  normalizeModelError,
  withFallback,
} from '../../src/models/index.js';
import {
  failure,
  fixtureText,
  interceptProviders,
  json,
  type Responder,
  readAll,
  sse,
  textDeltas,
} from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const anthropic = KITS.find((kit) => kit.provider === 'anthropic')!;
const openai = KITS.find((kit) => kit.provider === 'openai')!;
const PRIMARY = 'anthropic.messages/claude-haiku-4-5';
const SECONDARY = 'openai.chat/gpt-5.4-mini';

/** Anthropic (the primary) and OpenAI (the secondary) behind msw. */
function providers(options: { onFallback?: (event: FallbackEvent) => void } = {}) {
  return withFallback(
    [createLanguageModel(anthropic.spec), createLanguageModel(openai.spec)],
    options,
  );
}

function route(primary: Responder, secondary: Responder) {
  return http.reply((request, index) =>
    new URL(request.url).hostname === 'api.anthropic.com'
      ? primary(request, index)
      : secondary(request, index),
  );
}

const hosts = (requests: { url: URL }[]) => requests.map((request) => request.url.hostname);

const providerError = (statusCode: number, data?: unknown) =>
  new APICallError({
    message: 'failed',
    url: 'https://llm.example.test',
    requestBodyValues: {},
    statusCode,
    data,
  });

const GENERATED: LanguageModelV4GenerateResult = {
  content: [{ type: 'text', text: 'From the backup' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  },
  warnings: [],
};

const FINISH: LanguageModelV4StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: GENERATED.usage,
};

/** Emits `parts` one per read, then fails with `error` if given. */
function streamOf(parts: LanguageModelV4StreamPart[], error?: unknown) {
  let index = 0;
  return new ReadableStream<LanguageModelV4StreamPart>({
    pull(controller) {
      const part = parts[index++];
      if (part) controller.enqueue(part);
      else if (error !== undefined) controller.error(error);
      else controller.close();
    },
  });
}

const text = (delta: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta },
  { type: 'text-end', id: 't' },
];

function backup() {
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'backup',
    doGenerate: GENERATED,
    doStream: async () => ({
      stream: streamOf([
        { type: 'stream-start', warnings: [] },
        ...text('From the backup'),
        FINISH,
      ]),
    }),
  });
}

describe('withFallback with real providers', () => {
  it('serves from the secondary when the primary is overloaded (529)', async () => {
    const events: FallbackEvent[] = [];
    const requests = route(
      json(anthropic.fixtures.errors[529], 529),
      json(openai.fixtures.generate),
    );
    const result = await generateText({
      model: providers({ onFallback: (event) => events.push(event) }),
      prompt: 'Where is my order?',
      maxRetries: 0,
    });

    expect(result.text).toBe(openai.expected.text);
    expect(result.providerMetadata?.hamnivo).toEqual({ servedBy: SECONDARY, attempts: 2 });
    expect(hosts(requests)).toEqual(['api.anthropic.com', 'api.openai.com']);
    expect(events).toEqual([
      {
        from: PRIMARY,
        to: SECONDARY,
        error: expect.objectContaining({ kind: 'overloaded', status: 529, provider: 'anthropic' }),
      },
    ]);
  });

  it('streams from the secondary when the primary is overloaded (529)', async () => {
    const requests = route(json(anthropic.fixtures.errors[529], 529), sse(openai.fixtures.stream));
    const result = streamText({ model: providers(), prompt: 'Where is my order?', maxRetries: 0 });
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);

    expect(chunks.join('')).toBe(openai.expected.text);
    expect((await result.providerMetadata)?.hamnivo).toEqual({ servedBy: SECONDARY, attempts: 2 });
    expect(hosts(requests)).toEqual(['api.anthropic.com', 'api.openai.com']);
  });

  it('falls back when the primary stream opens with overloaded_error', async () => {
    const requests = route(
      sse(fixtureText('anthropic', 'overloaded-at-start.sse')),
      sse(openai.fixtures.stream),
    );
    const { stream } = await providers().doStream({ prompt: PROMPT });
    const parts = await readAll(stream);

    expect(textDeltas(parts)).toEqual(openai.expected.deltas);
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      providerMetadata: { hamnivo: { servedBy: SECONDARY, attempts: 2 } },
    });
    expect(hosts(requests)).toEqual(['api.anthropic.com', 'api.openai.com']);
  });

  it('does not fall back on an auth error', async () => {
    const requests = route(
      json(anthropic.fixtures.errors[401], 401),
      json(openai.fixtures.generate),
    );
    const error = await failure(
      generateText({ model: providers(), prompt: 'Where is my order?', maxRetries: 0 }),
    );
    expect(normalizeModelError(error)).toMatchObject({ kind: 'auth', status: 401 });
    expect(hosts(requests)).toEqual(['api.anthropic.com']);

    const streamed = await failure(providers().doStream({ prompt: PROMPT }));
    expect(normalizeModelError(streamed)).toMatchObject({ kind: 'auth' });
    expect(hosts(requests)).toEqual(['api.anthropic.com', 'api.anthropic.com']);
  });

  it('surfaces an error after partial stream output instead of falling back', async () => {
    const requests = route(
      sse(fixtureText('anthropic', 'overloaded-after-text.sse')),
      sse(openai.fixtures.stream),
    );
    const errors: unknown[] = [];
    const result = streamText({
      model: providers(),
      prompt: 'Where is my order?',
      maxRetries: 0,
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);

    expect(chunks).toEqual(['Order 1042 left']);
    expect(errors).toHaveLength(1);
    expect(normalizeModelError(errors[0])).toMatchObject({ kind: 'overloaded', status: 529 });
    expect(hosts(requests)).toEqual(['api.anthropic.com']);
  });
});

describe('withFallback streams', () => {
  it('passes a failure after content through and never calls the next model', async () => {
    const overloaded = providerError(529);
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf(
          [{ type: 'stream-start', warnings: [] }, ...text('Hel').slice(0, 2)],
          overloaded,
        ),
      }),
    });
    const next = backup();
    const { stream } = await withFallback([primary, next]).doStream({ prompt: PROMPT });
    const reader = stream.getReader();
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          seen.push(value.type);
        }
      })(),
    );

    expect(seen).toEqual(['stream-start', 'text-start', 'text-delta']);
    expect(error).toBe(overloaded);
    expect(next.doStreamCalls).toHaveLength(0);
  });

  it('falls back when a stream fails before any content', async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf(
          [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: '' },
          ],
          providerError(503),
        ),
      }),
    });
    const next = backup();
    const { stream } = await withFallback([primary, next]).doStream({ prompt: PROMPT });
    const parts = await readAll(stream);

    expect(textDeltas(parts)).toEqual(['From the backup']);
    expect(parts.filter((part) => part.type === 'stream-start')).toHaveLength(1);
    expect(next.doStreamCalls).toHaveLength(1);
  });

  it('falls back on an error part before any content', async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          {
            type: 'error',
            error: { type: 'overloaded_error', statusCode: 529, message: 'Overloaded' },
          },
        ]),
      }),
    });
    const { stream } = await withFallback([primary, backup()]).doStream({ prompt: PROMPT });
    const parts = await readAll(stream);

    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(textDeltas(parts)).toEqual(['From the backup']);
    expect(parts.at(-1)).toMatchObject({
      providerMetadata: { hamnivo: { servedBy: 'test/backup' } },
    });
  });

  it('keeps an error part that cannot fall back, in order', async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: providerError(401) },
          FINISH,
        ]),
      }),
    });
    const next = backup();
    const { stream } = await withFallback([primary, next]).doStream({ prompt: PROMPT });
    const parts = await readAll(stream);

    expect(parts.map((part) => part.type)).toEqual(['stream-start', 'error', 'finish']);
    expect(next.doStreamCalls).toHaveLength(0);
  });
});

describe('withFallback policy', () => {
  it.each([
    ['invalid_request', providerError(400)],
    ['content_filtered', providerError(400, { error: { code: 'content_filter', message: 'x' } })],
    [
      'context_length',
      providerError(400, { error: { code: 'context_length_exceeded', message: 'x' } }),
    ],
    ['aborted', new DOMException('The operation was aborted.', 'AbortError')],
  ])('never falls back on %s', async (kind, error) => {
    expect(normalizeModelError(error).kind).toBe(kind);
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        throw error;
      },
      doStream: async () => {
        throw error;
      },
    });
    const next = backup();
    const model = withFallback([primary, next]);

    expect(await failure(model.doGenerate({ prompt: PROMPT }))).toBe(error);
    expect(await failure(model.doStream({ prompt: PROMPT }))).toBe(error);
    expect(next.doGenerateCalls).toHaveLength(0);
    expect(next.doStreamCalls).toHaveLength(0);
  });

  it('does not fall back once the caller has aborted, even on a retryable error', async () => {
    const controller = new AbortController();
    const overloaded = providerError(529);
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        throw overloaded;
      },
    });
    const next = backup();
    const error = await failure(
      withFallback([primary, next]).doGenerate({ prompt: PROMPT, abortSignal: controller.signal }),
    );
    expect(error).toBe(overloaded);
    expect(next.doGenerateCalls).toHaveLength(0);
  });

  it('throws the last error when every model fails, and reports each switch', async () => {
    const events: FallbackEvent[] = [];
    const last = providerError(503);
    const failing = (error: unknown, modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doGenerate: async () => {
          throw error;
        },
      });
    const model = withFallback(
      [failing(providerError(429), 'a'), failing(providerError(500), 'b'), failing(last, 'c')],
      {
        onFallback: (event) => {
          events.push(event);
          throw new Error('a broken observer');
        },
      },
    );

    expect(await failure(model.doGenerate({ prompt: PROMPT }))).toBe(last);
    expect(events.map(({ from, to, error }) => [from, to, error.kind])).toEqual([
      ['mock-provider/a', 'mock-provider/b', 'rate_limited'],
      ['mock-provider/b', 'mock-provider/c', 'unavailable'],
    ]);
  });

  it('reports a single model as the one that served', async () => {
    const result = await withFallback([backup()]).doGenerate({ prompt: PROMPT });
    expect(result.providerMetadata).toEqual({ hamnivo: { servedBy: 'test/backup', attempts: 1 } });
  });

  it('describes itself and needs at least one model', () => {
    const model = withFallback([backup(), backup()]);
    expect(model.provider).toBe('hamnivo.fallback');
    expect(model.modelId).toBe('test/backup,test/backup');
    expect(model.supportedUrls).toEqual({});
    expect(() => withFallback([])).toThrow(TypeError);
  });
});
