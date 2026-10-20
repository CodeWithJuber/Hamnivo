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

/** Meter at the SDK/provider boundary, including every tool step and SDK retry. */
export function meteredModel(
  model: LanguageModelV4,
  credits: Pick<AiCreditsService, 'reserve' | 'settle' | 'release'>,
  spec: AiAttemptSpec,
): LanguageModelV4 {
  let step = 0;
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream')
        return () => {
          throw new Error('Metered execution currently requires generateText.');
        };
      if (property !== 'doGenerate') return Reflect.get(target, property, receiver);
      return async (call: Parameters<LanguageModelV4['doGenerate']>[0]) => {
        const reservation = await credits.reserve({
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
        let result: Awaited<ReturnType<LanguageModelV4['doGenerate']>>;
        try {
          result = await target.doGenerate(call);
        } catch (error) {
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
