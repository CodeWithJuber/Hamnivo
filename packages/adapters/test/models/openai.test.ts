import { embed, embedMany } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  createEmbeddingModel,
  createLanguageModel,
  normalizeModelError,
} from '../../src/models/index.js';
import { failure, fixtureJson, interceptProviders, json } from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const kit = KITS.find((candidate) => candidate.provider === 'openai')!;
const embeddingSpec = {
  provider: 'openai',
  modelId: 'text-embedding-3-small',
  apiKey: kit.key,
} as const;

const openaiError = (type: string, code: string | null, message = 'See the error code.') => ({
  error: { message, type, param: null, code },
});

describe('openai embeddings', () => {
  it('embeds several values in one request to /v1/embeddings', async () => {
    const body = fixtureJson('openai', 'embeddings.json');
    const requests = http.reply(json(body));
    const result = await embedMany({
      model: createEmbeddingModel(embeddingSpec),
      values: ['Where is my order?', 'How do refunds work?'],
      maxRetries: 0,
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url.href).toBe('https://api.openai.com/v1/embeddings');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${kit.key}`);
    expect(request?.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['Where is my order?', 'How do refunds work?'],
      encoding_format: 'float',
    });
    expect(result.embeddings).toEqual([body.data[0].embedding, body.data[1].embedding]);
    expect(result.usage.tokens).toBe(12);
  });

  it('embeds one value', async () => {
    const body = fixtureJson('openai', 'embeddings.json');
    http.reply(json({ ...body, data: [body.data[0]] }));
    const result = await embed({
      model: createEmbeddingModel(embeddingSpec),
      value: 'Where is my order?',
      maxRetries: 0,
    });
    expect(result.embedding).toEqual(body.data[0].embedding);
  });
});

// Codes from https://developers.openai.com/api/docs/guides/error-codes.
describe('openai errors', () => {
  const fail = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    http.reply(json(body, status, headers));
    const error = await failure(createLanguageModel(kit.spec).doGenerate({ prompt: PROMPT }));
    return normalizeModelError(error);
  };

  it('reads retry-after-ms before retry-after', async () => {
    const error = await fail(429, openaiError('requests', 'rate_limit_exceeded'), {
      'retry-after-ms': '250',
      'retry-after': '1',
    });
    expect(error).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 250 });
  });

  it.each([
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])('treats a 429 %s as a limit that waiting will not lift', async (code) => {
    const error = await fail(429, openaiError('insufficient_quota', code), { 'retry-after': '1' });
    expect(error).toEqual({
      kind: 'rate_limited',
      retryable: false,
      status: 429,
      provider: 'openai',
      message: `The provider rate limited the request (openai, HTTP 429, ${code})`,
    });
  });

  it('maps context_length_exceeded to context_length', async () => {
    const error = await fail(
      400,
      openaiError(
        'invalid_request_error',
        'context_length_exceeded',
        "This model's maximum context length is 400000 tokens. However, your messages resulted in 412000 tokens.",
      ),
    );
    expect(error).toMatchObject({ kind: 'context_length', retryable: false, status: 400 });
  });

  it('maps a safety-system rejection to content_filtered', async () => {
    const error = await fail(
      400,
      openaiError(
        'invalid_request_error',
        'content_policy_violation',
        'Your request was rejected as a result of our safety system.',
      ),
    );
    expect(error).toMatchObject({ kind: 'content_filtered', retryable: false });
  });

  it('never repeats the masked key from an invalid_api_key message', async () => {
    const error = await fail(401, fixtureJson('openai', 'errors.json')['401']);
    expect(error.message).toBe(
      'The provider rejected the credentials or the account (openai, HTTP 401, invalid_api_key)',
    );
  });
});
