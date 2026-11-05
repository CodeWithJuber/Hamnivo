import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { AiAttemptUncertainError, meteredModel } from '../src/billing/ai-credits.model.js';
import {
  type AiAttemptSpec,
  type AiReservation,
  measuredUsage,
  reservationSize,
} from '../src/billing/ai-credits.service.js';

const spec: AiAttemptSpec = {
  tenantId: 'tenant',
  key: 'run:r:generate:0:model:0',
  source: 'managed',
  provider: 'mock',
  modelId: 'test',
  reserveTokens: 20,
  timeoutMs: 1000,
};
const call: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  maxOutputTokens: 20,
};
const result = {
  usage: { inputTokens: { total: 12 }, outputTokens: { total: 7 } },
} as LanguageModelV4GenerateResult;
function fixture(run: () => Promise<LanguageModelV4GenerateResult>) {
  const credits = {
    reserve: vi.fn(
      async (s: AiAttemptSpec): Promise<AiReservation> => ({
        id: s.key,
        tenantId: s.tenantId,
        source: s.source,
        leaseToken: 'lease',
      }),
    ),
    settle: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const model = {
    specificationVersion: 'v4',
    doGenerate: vi.fn(run),
  } as unknown as LanguageModelV4;
  return { credits, raw: model, model: meteredModel(model, credits, spec) };
}

describe('provider-boundary AI metering', () => {
  it('reserves each step before the provider call, and settles actual usage', async () => {
    const f = fixture(async () => {
      expect(f.credits.reserve).toHaveBeenCalled();
      return result;
    });
    await f.model.doGenerate(call);
    await f.model.doGenerate(call);
    expect(f.credits.reserve.mock.calls.map(([s]) => s.key)).toEqual([
      `${spec.key}:step:0`,
      `${spec.key}:step:1`,
    ]);
    expect(f.credits.settle).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(f.credits.release).not.toHaveBeenCalled();
  });
  it('does not call the provider when reservation fails', async () => {
    const f = fixture(async () => result);
    f.credits.reserve.mockRejectedValueOnce(new Error('quota'));
    await expect(f.model.doGenerate(call)).rejects.toThrow('quota');
    expect(f.raw.doGenerate).not.toHaveBeenCalled();
  });
  it('releases a definite rejected request so explicit fallback can run', async () => {
    const failure = Object.assign(new Error('rate limit'), { statusCode: 429 });
    const f = fixture(async () => {
      throw failure;
    });
    await expect(f.model.doGenerate(call)).rejects.toBe(failure);
    expect(f.credits.release).toHaveBeenCalledOnce();
    expect(f.credits.settle).not.toHaveBeenCalled();
  });
  it('accounts for measured usage on provider failure', async () => {
    const failure = Object.assign(new Error('failed after generation'), {
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const f = fixture(async () => {
      throw failure;
    });
    await expect(f.model.doGenerate(call)).rejects.toBe(failure);
    expect(f.credits.settle).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: 5,
      outputTokens: 3,
    });
    expect(f.credits.release).not.toHaveBeenCalled();
  });
  it('retains uncertain reservations and prevents blind retries', async () => {
    const f = fixture(async () => {
      throw new Error('socket closed');
    });
    await expect(f.model.doGenerate(call)).rejects.toBeInstanceOf(AiAttemptUncertainError);
    expect(f.credits.settle).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: null,
      outputTokens: null,
    });
    expect(f.credits.release).not.toHaveBeenCalled();
  });
  it('never converts settlement failure into a provider retry or refund', async () => {
    const f = fixture(async () => result);
    f.credits.settle.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.model.doGenerate(call)).rejects.toBeInstanceOf(AiAttemptUncertainError);
    expect(f.credits.release).not.toHaveBeenCalled();
    expect(f.raw.doGenerate).toHaveBeenCalledOnce();
  });
  it('preserves partial receipts without inventing missing usage', () => {
    expect(measuredUsage({ usage: { inputTokens: 9 } })).toEqual({
      inputTokens: 9,
      outputTokens: null,
    });
    expect(measuredUsage({ cause: { totalUsage: { inputTokens: 3, outputTokens: 4 } } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(measuredUsage({ usage: { inputTokens: -1, outputTokens: NaN } })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
    expect(measuredUsage({ data: { usage: { prompt_tokens: 8, completion_tokens: 2 } } })).toEqual({
      inputTokens: 8,
      outputTokens: 2,
    });
    expect(reservationSize('hi', ['hello'], 10, 1)).toBeGreaterThan(10);
  });
});
