import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  type AiAttemptSpec,
  type AiCreditsService,
  measuredUsage,
  reservationSize,
} from './ai-credits.service.js';

/** Never retry an unaccounted call: a network failure is not evidence of zero provider usage. */
export class AiAttemptUncertainError extends Error {
  constructor(cause: unknown) {
    super('AI provider usage could not be fully reconciled; the reservation remains held.', {
      cause,
    });
    this.name = 'AiAttemptUncertainError';
  }
}

function rejectedBeforeGeneration(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  // Authentication, validation and rate-limit rejections cannot have generated a completion.
  return typeof status === 'number' && [400, 401, 403, 404, 422, 429].includes(status);
}

type Call = Parameters<LanguageModelV4['doGenerate']>[0];
type Credits = Pick<AiCreditsService, 'reserve' | 'settle' | 'release'>;
type Reservation = Awaited<ReturnType<Credits['reserve']>>;
type StreamPart =
  Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

/**
 * What to do when a provider call fails before it returned anything: settle what the error
 * says was used, release a request the provider refused outright, and otherwise keep the
 * reservation held. Always throws.
 */
async function failed(credits: Credits, reservation: Reservation, error: unknown): Promise<never> {
  const usage = measuredUsage(error);
  if (usage.inputTokens !== null || usage.outputTokens !== null) {
    try {
      await credits.settle(reservation, usage);
    } catch (settlementError) {
      throw new AiAttemptUncertainError(settlementError);
    }
    if (usage.inputTokens !== null && usage.outputTokens !== null) throw error;
  } else if (rejectedBeforeGeneration(error)) {
    try {
      await credits.release(reservation);
    } catch (releaseError) {
      throw new AiAttemptUncertainError(releaseError);
    }
    throw error;
  } else {
    try {
      await credits.settle(reservation, usage);
    } catch {
      /* Original reservation remains held. */
    }
  }
  throw new AiAttemptUncertainError(error);
}

/**
 * The provider's stream, settled when it ends: with the usage its `finish` part reports, or, for
 * a stream that broke off, was cancelled or never said what it used, with what is known, leaving
 * the reservation held. A stream that did not end with its usage errors with
 * AiAttemptUncertainError, so nothing retries a call that may have been billed.
 */
function settledStream(
  upstream: ReadableStream<StreamPart>,
  credits: Credits,
  reservation: Reservation,
): ReadableStream<StreamPart> {
  const reader = upstream.getReader();
  let usage: ReturnType<typeof measuredUsage> | null = null;
  let done = false;
  const settle = async (seen: ReturnType<typeof measuredUsage>) => {
    if (done) return;
    done = true;
    await credits.settle(reservation, seen);
  };
  const unknown = { inputTokens: null, outputTokens: null };
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      let next: ReadableStreamReadResult<StreamPart>;
      try {
        next = await reader.read();
      } catch (error) {
        await settle(usage ?? unknown).catch(() => undefined);
        controller.error(new AiAttemptUncertainError(error));
        return;
      }
      if (!next.done) {
        if (next.value.type === 'finish') usage = measuredUsage(next.value.usage);
        controller.enqueue(next.value);
        return;
      }
      const complete = usage !== null && usage.inputTokens !== null && usage.outputTokens !== null;
      try {
        await settle(usage ?? unknown);
      } catch (error) {
        controller.error(new AiAttemptUncertainError(error));
        return;
      }
      if (complete) controller.close();
      else controller.error(new AiAttemptUncertainError(new Error('stream ended without usage')));
    },
    async cancel(reason) {
      // Stopped by the reader (a customer's Stop, a superseded reply): the provider may still
      // count what it generated, so the reservation stays held unless the usage is known.
      await reader.cancel(reason).catch(() => undefined);
      await settle(usage ?? unknown).catch(() => undefined);
    },
  });
}

/** Meter at the SDK/provider boundary, including every tool step and SDK retry. */
export function meteredModel(
  model: LanguageModelV4,
  credits: Credits,
  spec: AiAttemptSpec,
): LanguageModelV4 {
  let step = 0;
  const reserve = (call: Call) =>
    credits.reserve({
      ...spec,
      key: `${spec.key}:step:${step++}`,
      reserveTokens: Math.max(
        spec.reserveTokens,
        reservationSize(
          '',
          { prompt: call.prompt, tools: call.tools },
          call.maxOutputTokens ?? 4096,
          1,
        ),
      ),
    });
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream') {
        return async (call: Call) => {
          const reservation = await reserve(call);
          let result: Awaited<ReturnType<LanguageModelV4['doStream']>>;
          try {
            result = await target.doStream(call);
          } catch (error) {
            return failed(credits, reservation, error);
          }
          return { ...result, stream: settledStream(result.stream, credits, reservation) };
        };
      }
      if (property !== 'doGenerate') return Reflect.get(target, property, receiver);
      return async (call: Call) => {
        const reservation = await reserve(call);
        let result: Awaited<ReturnType<LanguageModelV4['doGenerate']>>;
        try {
          result = await target.doGenerate(call);
        } catch (error) {
          return failed(credits, reservation, error);
        }
        try {
          await credits.settle(reservation, measuredUsage(result));
        } catch (error) {
          throw new AiAttemptUncertainError(error);
        }
        return result;
      };
    },
  });
}
