import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLanguageModel, type ModelSpec } from '../../src/models/index.js';

// Real provider calls need the network and cost money, so they run only on request, and only
// for providers whose key is set. HAMNIVO_LIVE_MODELS guards against a key that happens to be
// exported in the shell:
//   HAMNIVO_LIVE_MODELS=1 ANTHROPIC_API_KEY=… pnpm --filter @hamnivo/adapters test live
const env = (name: string) => process.env[name] || undefined;
const requested = env('HAMNIVO_LIVE_MODELS') === '1';

const cases: { provider: string; ready: boolean; spec: () => ModelSpec }[] = [
  {
    provider: 'anthropic',
    ready: Boolean(env('ANTHROPIC_API_KEY')),
    spec: () => ({
      provider: 'anthropic',
      modelId: env('HAMNIVO_LIVE_ANTHROPIC_MODEL') ?? 'claude-haiku-4-5',
      apiKey: env('ANTHROPIC_API_KEY'),
    }),
  },
  {
    provider: 'openai',
    ready: Boolean(env('OPENAI_API_KEY')),
    spec: () => ({
      provider: 'openai',
      modelId: env('HAMNIVO_LIVE_OPENAI_MODEL') ?? 'gpt-5.4-nano',
      apiKey: env('OPENAI_API_KEY'),
    }),
  },
  {
    provider: 'google',
    ready: Boolean(env('GOOGLE_GENERATIVE_AI_API_KEY')),
    spec: () => ({
      provider: 'google',
      modelId: env('HAMNIVO_LIVE_GOOGLE_MODEL') ?? 'gemini-flash-lite-latest',
      apiKey: env('GOOGLE_GENERATIVE_AI_API_KEY'),
    }),
  },
  {
    provider: 'openai-compatible',
    ready: Boolean(env('OPENAI_COMPATIBLE_BASE_URL') && env('OPENAI_COMPATIBLE_MODEL')),
    spec: () => ({
      provider: 'openai-compatible',
      modelId: env('OPENAI_COMPATIBLE_MODEL') ?? '',
      baseURL: env('OPENAI_COMPATIBLE_BASE_URL'),
      apiKey: env('OPENAI_COMPATIBLE_API_KEY'),
    }),
  },
];

for (const { provider, ready, spec } of cases) {
  describe.skipIf(!requested || !ready)(`live ${provider}`, () => {
    it('answers one tiny prompt and reports usage', { timeout: 60_000 }, async () => {
      const result = await generateText({
        model: createLanguageModel(spec()),
        prompt: 'Reply with one word: pong',
        maxOutputTokens: 256,
        maxRetries: 1,
      });
      expect(result.finishReason).not.toBe('error');
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    });
  });
}
