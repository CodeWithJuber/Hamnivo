import { describe, expect, it } from 'vitest';
import {
  capabilitiesOf,
  createEmbeddingModel,
  createLanguageModel,
  ModelCapabilityError,
  normalizeModelError,
} from '../../src/models/index.js';
import {
  failure,
  fixtureText,
  interceptProviders,
  json,
  readAll,
  sse,
  textDeltas,
} from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const kit = KITS.find((candidate) => candidate.provider === 'anthropic')!;
const model = () => createLanguageModel(kit.spec);

const envelope = (type: string, message: string) => ({ type: 'error', error: { type, message } });

describe('anthropic capabilities', () => {
  it('has no embeddings, so asking for them throws a typed capability error', () => {
    expect(capabilitiesOf(kit.spec)).toEqual({
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      embeddings: false,
      imageInput: true,
    });
    const error = (() => {
      try {
        createEmbeddingModel({ ...kit.spec, modelId: 'voyage-4' });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ModelCapabilityError);
    expect(error).toMatchObject({ provider: 'anthropic', capability: 'embeddings' });
    expect(normalizeModelError(error)).toEqual({
      kind: 'invalid_request',
      retryable: false,
      message: 'anthropic models do not support embeddings',
    });
  });

  it('cannot be declared into having embeddings', () => {
    const spec = { ...kit.spec, capabilities: { embeddings: true } };
    expect(capabilitiesOf(spec).embeddings).toBe(false);
    expect(() => createEmbeddingModel(spec)).toThrow(ModelCapabilityError);
  });
});

describe('anthropic stream errors', () => {
  it('fails the call with a 529 when overloaded_error is the first event', async () => {
    http.reply(sse(fixtureText('anthropic', 'overloaded-at-start.sse')));
    const error = await failure(model().doStream({ prompt: PROMPT }));
    expect(normalizeModelError(error, { provider: 'anthropic' })).toMatchObject({
      kind: 'overloaded',
      retryable: true,
      status: 529,
    });
  });

  it('reports overloaded_error after text as an error part after that text', async () => {
    http.reply(sse(fixtureText('anthropic', 'overloaded-after-text.sse')));
    const { stream } = await model().doStream({ prompt: PROMPT });
    const parts = await readAll(stream);
    expect(textDeltas(parts)).toEqual(['Order 1042 left']);
    const errorPart = parts.find((part) => part.type === 'error');
    expect(normalizeModelError(errorPart?.error)).toMatchObject({
      kind: 'overloaded',
      retryable: true,
      status: 529,
    });
  });
});

// Statuses and types from https://platform.claude.com/docs/en/api/errors.
describe('anthropic HTTP errors', () => {
  it.each([
    [400, 'invalid_request_error', 'messages: roles must alternate', 'invalid_request', false],
    [
      400,
      'invalid_request_error',
      'prompt is too long: 208310 tokens > 200000 maximum',
      'context_length',
      false,
    ],
    [402, 'billing_error', 'There is an issue with your billing.', 'auth', false],
    [403, 'permission_error', 'Your API key does not have permission.', 'auth', false],
    [404, 'not_found_error', 'model: claude-unknown', 'invalid_request', false],
    [
      413,
      'request_too_large',
      'Request exceeds the maximum allowed number of bytes.',
      'context_length',
      false,
    ],
    [504, 'timeout_error', 'The request timed out while processing.', 'timeout', true],
  ])('%i %s is %s', async (status, type, message, kind, retryable) => {
    http.reply(json(envelope(type, message), status));
    const error = await failure(model().doGenerate({ prompt: PROMPT }));
    const normalized = normalizeModelError(error);
    expect(normalized).toMatchObject({ kind, retryable, status, provider: 'anthropic' });
    expect(normalized.message).toContain(type);
    expect(normalized.message).not.toContain(message);
  });
});
