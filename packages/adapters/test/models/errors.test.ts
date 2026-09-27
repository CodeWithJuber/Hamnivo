import { APICallError } from '@ai-sdk/provider';
import { generateText, RetryError } from 'ai';
import { HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLanguageModel,
  ModelConfigError,
  normalizeModelError,
} from '../../src/models/index.js';
import { failure, interceptProviders, json } from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const anthropic = KITS.find((kit) => kit.provider === 'anthropic')!;

const apiError = (options: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) =>
  new APICallError({
    message: 'Provider said no',
    url: 'https://api.openai.com/v1/chat/completions',
    requestBodyValues: {},
    ...options,
  });

const networkCause = (code: string) =>
  Object.assign(new Error(`connect ${code} 203.0.113.7:443`), { code });

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeModelError never leaks secrets', () => {
  it('builds the message without the key, the URL query or the prompt', () => {
    const secret = 'AIzaSyD-live-secret-key-1234567890abcdef';
    const prompt = 'My card number is 4242 4242 4242 4242';
    const error = apiError({
      message: `API key ${secret} is not valid for "${prompt}"`,
      url: `https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${secret}`,
      requestBodyValues: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          code: 400,
          message: `API key ${secret} not valid: ${prompt}`,
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      }),
    });

    const normalized = normalizeModelError(error);
    expect(normalized).toEqual({
      kind: 'auth',
      retryable: false,
      status: 400,
      provider: 'google',
      message:
        'The provider rejected the credentials or the account (google, HTTP 400, INVALID_ARGUMENT)',
    });
  });

  it('drops provider codes that are not plain identifiers', () => {
    const error = apiError({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { type: 'sk-live-0123456789', code: 'my card is 4242', message: 'bad' },
      }),
    });
    expect(normalizeModelError(error).message).toBe(
      'The provider rejected the request (openai, HTTP 400)',
    );
  });
});

describe('normalizeModelError unwraps the AI SDK', () => {
  it('reads the last attempt of a RetryError', () => {
    const overloaded = apiError({
      url: 'https://api.anthropic.com/v1/messages',
      statusCode: 529,
      data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    const error = new RetryError({
      message: 'Failed after 3 attempts.',
      reason: 'maxRetriesExceeded',
      errors: [apiError({ statusCode: 500 }), overloaded],
    });
    expect(normalizeModelError(error)).toEqual({
      kind: 'overloaded',
      retryable: true,
      status: 529,
      provider: 'anthropic',
      message: 'The provider is overloaded (anthropic, HTTP 529, overloaded_error)',
    });
  });

  it('classifies what generateText throws after its own retries', async () => {
    const body = anthropic.fixtures.errors[529];
    const requests = http.reply(json(body, 529, { 'retry-after-ms': '1' }));
    const error = await failure(
      generateText({ model: createLanguageModel(anthropic.spec), prompt: 'Hi', maxRetries: 1 }),
    );
    expect(requests).toHaveLength(2);
    expect(RetryError.isInstance(error)).toBe(true);
    expect(normalizeModelError(error)).toMatchObject({ kind: 'overloaded', retryAfterMs: 1 });
  });

  it('reads provider stream errors, which carry the fields on the error itself', () => {
    const streamError = {
      message: 'Rate limit reached',
      type: 'requests',
      code: 'rate_limit_exceeded',
      statusCode: 429,
      isRetryable: true,
    };
    expect(normalizeModelError(streamError, { provider: 'openai.chat' })).toEqual({
      kind: 'rate_limited',
      retryable: true,
      status: 429,
      provider: 'openai',
      message: 'The provider rate limited the request (openai, HTTP 429, rate_limit_exceeded)',
    });
  });
});

describe('normalizeModelError on network failures', () => {
  it('treats a refused connection through the SDK as unavailable', async () => {
    http.reply(() => HttpResponse.error());
    const error = await failure(createLanguageModel(anthropic.spec).doGenerate({ prompt: PROMPT }));
    expect(normalizeModelError(error, { provider: 'anthropic' })).toMatchObject({
      kind: 'unavailable',
      retryable: true,
      provider: 'anthropic',
    });
  });

  it('treats TypeError: fetch failed as unavailable and names the socket error', () => {
    const error = new TypeError('fetch failed', { cause: networkCause('ECONNREFUSED') });
    expect(normalizeModelError(error)).toEqual({
      kind: 'unavailable',
      retryable: true,
      message: 'The provider is unavailable (ECONNREFUSED)',
    });
  });

  it('treats connect and header timeouts as timeouts', () => {
    const error = new TypeError('fetch failed', { cause: networkCause('UND_ERR_CONNECT_TIMEOUT') });
    expect(normalizeModelError(error)).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('treats the SDK "Cannot connect to API" error as unavailable', () => {
    const error = apiError({
      message: 'Cannot connect to API: connect ECONNRESET',
      cause: networkCause('ECONNRESET'),
      isRetryable: true,
    });
    expect(normalizeModelError(error)).toMatchObject({
      kind: 'unavailable',
      retryable: true,
      provider: 'openai',
    });
    expect(normalizeModelError(error).status).toBeUndefined();
  });
});

describe('normalizeModelError on cancellation', () => {
  it('treats AbortError as aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(normalizeModelError(controller.signal.reason)).toEqual({
      kind: 'aborted',
      retryable: false,
      message: 'The model call was aborted',
    });
  });

  it('treats TimeoutError from AbortSignal.timeout as a retryable timeout', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(normalizeModelError(signal.reason)).toMatchObject({ kind: 'timeout', retryable: true });
  });
});

describe('normalizeModelError on retry hints', () => {
  it('reads an HTTP-date retry-after', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
    const error = apiError({
      statusCode: 503,
      responseHeaders: { 'Retry-After': 'Sun, 27 Sep 2026 10:00:30 GMT' },
    });
    expect(normalizeModelError(error)).toMatchObject({ kind: 'unavailable', retryAfterMs: 30_000 });
  });

  it('gives no wait for errors that are not retryable', () => {
    const error = apiError({ statusCode: 400, responseHeaders: { 'retry-after': '5' } });
    expect(normalizeModelError(error)).not.toHaveProperty('retryAfterMs');
  });
});

describe('normalizeModelError classification', () => {
  it.each([
    [{ statusCode: 408 }, 'timeout', true],
    [{ statusCode: 502 }, 'unavailable', true],
    [{ statusCode: 404 }, 'invalid_request', false],
    [{ statusCode: 422 }, 'invalid_request', false],
    [
      {
        statusCode: 400,
        data: { error: { message: 'x', type: 'invalid_request_error', code: 'content_filter' } },
      },
      'content_filtered',
      false,
    ],
    [
      {
        statusCode: 400,
        data: {
          error: {
            message:
              "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
          },
        },
      },
      'content_filtered',
      false,
    ],
  ] as const)('%j is %s', (options, kind, retryable) => {
    expect(normalizeModelError(apiError(options))).toMatchObject({ kind, retryable });
  });

  it('treats a missing key from the registry as auth and keeps its message', () => {
    const error = new ModelConfigError('apiKey', 'openai needs an API key in the model spec');
    expect(normalizeModelError(error)).toEqual({
      kind: 'auth',
      retryable: false,
      message: 'openai needs an API key in the model spec',
    });
  });

  it('calls anything else unknown and not retryable', () => {
    expect(normalizeModelError(new Error('socket hang up at /secret/path'))).toEqual({
      kind: 'unknown',
      retryable: false,
      message: 'The model call failed',
    });
    expect(normalizeModelError('boom')).toMatchObject({ kind: 'unknown', retryable: false });
    expect(normalizeModelError(undefined)).toMatchObject({ kind: 'unknown' });
  });

  it('names the provider from context, including SDK provider ids', () => {
    const error = apiError({
      url: 'https://llm.example.test/v1/chat/completions',
      statusCode: 500,
    });
    expect(normalizeModelError(error).provider).toBeUndefined();
    expect(normalizeModelError(error, { provider: 'ollama.chat' }).provider).toBe('ollama');
    expect(normalizeModelError(error, { provider: 'openai-compatible' }).provider).toBe(
      'openai-compatible',
    );
  });
});
