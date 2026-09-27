import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { generateText, streamText } from 'ai';
import { delay } from 'msw';
import { describe, expect, it } from 'vitest';
import { createLanguageModel, normalizeModelError } from '../../src/models/index.js';
import {
  failure,
  type interceptProviders,
  json,
  type Responder,
  readAll,
  sse,
  textDeltas,
} from './harness.js';
import { type ErrorStatus, PROMPT, PROMPT_TEXTS, type ProviderKit, SYSTEM, TURNS } from './kits.js';

type Http = ReturnType<typeof interceptProviders>;
type Mode = 'generate' | 'stream';

/**
 * The behavior every real provider adapter must share (E06). Provider differences live in the
 * kit: wire format, auth header, fixtures and what each server status means.
 */
export function describeProviderContract(kit: ProviderKit, http: Http) {
  const model = () => createLanguageModel(kit.spec);

  /** One model call in either mode; a stream is read to the end. */
  const call = async (mode: Mode, abortSignal?: AbortSignal) => {
    if (mode === 'generate') return model().doGenerate({ prompt: PROMPT, abortSignal });
    const { stream } = await model().doStream({ prompt: PROMPT, abortSignal });
    return readAll(stream);
  };

  const expectSafeMessage = (message: string) => {
    expect(message).not.toContain(kit.key);
    for (const text of PROMPT_TEXTS) expect(message).not.toContain(text);
  };

  describe(`${kit.provider} contract`, () => {
    it('generates: parses text, usage and finish reason', async () => {
      const requests = http.reply(json(kit.fixtures.generate));
      const result = await model().doGenerate({ prompt: PROMPT });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.href).toBe(kit.urls.generate);
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: kit.expected.text }),
      ]);
      expect(result.finishReason).toEqual({ unified: 'stop', raw: kit.expected.finishRaw });
      expect(result.usage.inputTokens.total).toBe(kit.expected.inputTokens);
      expect(result.usage.outputTokens.total).toBe(kit.expected.outputTokens);
    });

    it('streams: ordered text deltas, then a finish part', async () => {
      const requests = http.reply(sse(kit.fixtures.stream));
      const { stream } = await model().doStream({ prompt: PROMPT });
      const parts = await readAll(stream);

      expect(requests).toHaveLength(1);
      kit.assertStreamRequest(requests[0] as (typeof requests)[number]);
      expect(textDeltas(parts)).toEqual(kit.expected.deltas);
      const types = parts.map((part) => part.type).filter((type) => type !== 'raw');
      expect(types[0]).toBe('stream-start');
      const textStart = types.indexOf('text-start');
      expect(textStart).toBeGreaterThan(0);
      expect(textStart).toBeLessThan(types.indexOf('text-delta'));
      expect(types.lastIndexOf('text-delta')).toBeLessThan(types.indexOf('text-end'));
      expect(types.at(-1)).toBe('finish');
      const finish = parts.at(-1) as Extract<LanguageModelV4StreamPart, { type: 'finish' }>;
      expect(finish.finishReason).toEqual({ unified: 'stop', raw: kit.expected.finishRaw });
      expect(finish.usage.inputTokens.total).toBe(kit.expected.inputTokens);
      expect(finish.usage.outputTokens.total).toBe(kit.expected.outputTokens);
    });

    it('streams through streamText as the same text', async () => {
      http.reply(sse(kit.fixtures.stream));
      const result = streamText({ model: model(), prompt: 'Hello', maxRetries: 0 });
      const chunks: string[] = [];
      for await (const chunk of result.textStream) chunks.push(chunk);
      expect(chunks.join('')).toBe(kit.expected.text);
      expect(await result.finishReason).toBe('stop');
    });

    it('sends the system prompt and turns in the provider wire format', async () => {
      const requests = http.reply(json(kit.fixtures.generate));
      const result = await generateText({
        model: model(),
        system: SYSTEM,
        messages: TURNS,
        maxRetries: 0,
      });

      expect(result.text).toBe(kit.expected.text);
      kit.assertWire(requests[0]?.body);
    });

    it('sends the API key in the provider header, never in the URL or body', async () => {
      const requests = http.reply(json(kit.fixtures.generate), sse(kit.fixtures.stream));
      await call('generate');
      await call('stream');

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        kit.assertAuth(request);
        expect(request.url.href).not.toContain(kit.key);
        expect(JSON.stringify(request.body)).not.toContain(kit.key);
      }
    });

    describe.each<Mode>(['generate', 'stream'])('%s failures', (mode) => {
      const fail = async (responder: Responder) => {
        http.reply(responder);
        return normalizeModelError(await failure(call(mode)), { provider: kit.spec.provider });
      };
      const errorBody = (status: ErrorStatus) => kit.fixtures.errors[status];

      it('401 is auth, not retryable, and the message holds no key or prompt text', async () => {
        const error = await fail(json(errorBody(401), 401));
        expect(error).toMatchObject({
          kind: 'auth',
          retryable: false,
          status: 401,
          provider: kit.provider,
        });
        expectSafeMessage(error.message);
      });

      it('429 with retry-after is rate_limited with retryAfterMs', async () => {
        const error = await fail(json(errorBody(429), 429, { 'retry-after': '7' }));
        expect(error).toMatchObject({
          kind: 'rate_limited',
          retryable: true,
          retryAfterMs: 7000,
          status: 429,
        });
        expectSafeMessage(error.message);
      });

      it.each([500, 503, 529] as const)('%i is retryable', async (status) => {
        const error = await fail(json(errorBody(status), status));
        expect(error).toMatchObject({
          kind: kit.expected.serverKinds[status],
          retryable: true,
          status,
        });
      });

      it('an aborted call is aborted, not retryable', async () => {
        let arrived!: () => void;
        const reached = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        http.reply(async () => {
          arrived();
          await delay('infinite');
          return new Response(null);
        });
        const controller = new AbortController();
        const outcome = failure(call(mode, controller.signal));
        await reached;
        controller.abort();
        expect(normalizeModelError(await outcome)).toMatchObject({
          kind: 'aborted',
          retryable: false,
        });
      });
    });
  });
}
