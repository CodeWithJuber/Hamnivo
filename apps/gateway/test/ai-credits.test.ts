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

describe('metered streaming', () => {
  /**
   * A provider stream of these parts; `broken` errors after them instead of ending, and `open`
   * keeps it going, as a provider still generating does.
   */
  function streaming(parts: unknown[], broken?: Error, open = false) {
    const f = fixture(async () => result);
    const cancelled = vi.fn();
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          if (broken) controller.error(broken);
          else if (!open) controller.close();
        },
        cancel: cancelled,
      }),
    }));
    (f.raw as unknown as { doStream: typeof doStream }).doStream = doStream;
    return { ...f, doStream, cancelled };
  }
  const read = async (stream: ReadableStream<unknown>) => {
    const seen: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) return seen;
      seen.push(next.value);
    }
  };
  const finish = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 30 }, outputTokens: { total: 11 } },
  };

  it('reserves before the provider streams, and settles the usage its finish part reports', async () => {
    const f = streaming([
      { type: 'text-delta', id: 't', delta: 'Hello' },
      { type: 'text-delta', id: 't', delta: ' there.' },
      finish,
    ]);
    const { stream } = await f.model.doStream(call);
    expect(f.credits.reserve).toHaveBeenCalledOnce();
    expect(f.credits.settle).not.toHaveBeenCalled();
    const parts = await read(stream);
    expect(parts).toHaveLength(3);
    expect(f.credits.settle).toHaveBeenCalledOnce();
    expect(f.credits.settle).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: 30,
      outputTokens: 11,
    });
  });

  it('keeps the reservation held, and says so, when a stream ends without its usage', async () => {
    const f = streaming([{ type: 'text-delta', id: 't', delta: 'Hello' }]);
    const { stream } = await f.model.doStream(call);
    await expect(read(stream)).rejects.toBeInstanceOf(AiAttemptUncertainError);
    expect(f.credits.settle).toHaveBeenCalledWith(expect.anything(), {
      inputTokens: null,
      outputTokens: null,
    });
    expect(f.credits.release).not.toHaveBeenCalled();
  });

  it('treats a stream that breaks off as uncertain, never as free', async () => {
    const f = streaming([{ type: 'text-delta', id: 't', delta: 'Hel' }], new Error('reset'));
    const { stream } = await f.model.doStream(call);
    await expect(read(stream)).rejects.toBeInstanceOf(AiAttemptUncertainError);
    expect(f.credits.settle).toHaveBeenCalledOnce();
    expect(f.credits.release).not.toHaveBeenCalled();
  });

  it('settles once when the reader stops it early, and stops the provider’s stream', async () => {
    const f = streaming([{ type: 'text-delta', id: 't', delta: 'Hello' }], undefined, true);
    const { stream } = await f.model.doStream(call);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel('stopped');
    expect(f.cancelled).toHaveBeenCalled();
    expect(f.credits.settle).toHaveBeenCalledOnce();
    expect(f.credits.release).not.toHaveBeenCalled();
  });

  it('releases a request the provider refused before streaming anything', async () => {
    const f = streaming([]);
    f.doStream.mockRejectedValueOnce(Object.assign(new Error('rate limit'), { statusCode: 429 }));
    await expect(f.model.doStream(call)).rejects.toThrow('rate limit');
    expect(f.credits.release).toHaveBeenCalledOnce();
    expect(f.credits.settle).not.toHaveBeenCalled();
  });
});
