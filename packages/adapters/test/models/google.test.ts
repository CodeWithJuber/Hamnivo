import { embed, embedMany } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  createEmbeddingModel,
  createLanguageModel,
  normalizeModelError,
} from '../../src/models/index.js';
import { type Captured, failure, fixtureJson, interceptProviders, json } from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const kit = KITS.find((candidate) => candidate.provider === 'google')!;
const embeddingSpec = {
  provider: 'google',
  modelId: 'gemini-embedding-001',
  apiKey: kit.key,
} as const;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001';

const expectKeyInHeader = (request: Captured | undefined) => {
  expect(request?.headers.get('x-goog-api-key')).toBe(kit.key);
  expect(request?.url.searchParams.has('key')).toBe(false);
  expect(request?.url.href).not.toContain(kit.key);
};

describe('google embeddings', () => {
  it('embeds one value with embedContent, the key in x-goog-api-key', async () => {
    const body = fixtureJson('google', 'embed-content.json');
    const requests = http.reply(json(body));
    const result = await embed({
      model: createEmbeddingModel(embeddingSpec),
      value: 'Where is my order?',
      maxRetries: 0,
    });

    expect(requests[0]?.url.href).toBe(`${BASE}:embedContent`);
    expectKeyInHeader(requests[0]);
    expect(requests[0]?.body).toMatchObject({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'Where is my order?' }] },
    });
    expect(result.embedding).toEqual(body.embedding.values);
  });

  it('embeds several values with batchEmbedContents', async () => {
    const body = fixtureJson('google', 'batch-embed-contents.json');
    const requests = http.reply(json(body));
    const result = await embedMany({
      model: createEmbeddingModel(embeddingSpec),
      values: ['Where is my order?', 'How do refunds work?'],
      maxRetries: 0,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe(`${BASE}:batchEmbedContents`);
    expectKeyInHeader(requests[0]);
    expect(requests[0]?.body.requests).toHaveLength(2);
    expect(result.embeddings).toEqual(
      body.embeddings.map((item: { values: number[] }) => item.values),
    );
  });
});

// google.rpc.Status bodies (https://google.aip.dev/193); statuses from
// https://ai.google.dev/gemini-api/docs/troubleshooting.
describe('google errors', () => {
  const fail = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    http.reply(json(body, status, headers));
    const error = await failure(createLanguageModel(kit.spec).doGenerate({ prompt: PROMPT }));
    return normalizeModelError(error);
  };

  it('treats 400 API_KEY_INVALID as auth, although the status is 400', async () => {
    const error = await fail(400, fixtureJson('google', 'api-key-invalid.json'));
    expect(error).toMatchObject({
      kind: 'auth',
      retryable: false,
      status: 400,
      provider: 'google',
    });
  });

  it('takes the wait from RetryInfo when a 429 RESOURCE_EXHAUSTED has no retry-after', async () => {
    const error = await fail(429, fixtureJson('google', 'errors.json')['429']);
    expect(error).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 37_000 });
    expect(error.message).toContain('RESOURCE_EXHAUSTED');
  });

  it('treats 503 UNAVAILABLE "model is overloaded" as overloaded', async () => {
    const error = await fail(503, fixtureJson('google', 'errors.json')['503']);
    expect(error).toMatchObject({ kind: 'overloaded', retryable: true, status: 503 });
  });

  it('treats 504 DEADLINE_EXCEEDED as a retryable timeout', async () => {
    const error = await fail(504, {
      error: {
        code: 504,
        message: 'Deadline expired before operation could complete.',
        status: 'DEADLINE_EXCEEDED',
      },
    });
    expect(error).toMatchObject({ kind: 'timeout', retryable: true, status: 504 });
  });

  it('treats an input over the token limit as context_length', async () => {
    const error = await fail(400, {
      error: {
        code: 400,
        message:
          'The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).',
        status: 'INVALID_ARGUMENT',
      },
    });
    expect(error).toMatchObject({ kind: 'context_length', retryable: false });
  });
});
