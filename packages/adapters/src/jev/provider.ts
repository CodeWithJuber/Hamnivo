import {
  type DecisionAnswers,
  type DecisionAudit,
  type DecisionProvider,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  validateDecisionRequest,
} from '@hamnivo/domain';
import { type Fetch, type Logger, TypeSafeClient } from '@typesafe-ai/sdk';
import { type BreakerOptions, createCircuitBreaker } from './breaker.js';
import { fromJevError, type JevOutcome, readJevResponse, toJevQuestions } from './wire.js';

export type { BreakerOptions } from './breaker.js';

export const JEV_PROVIDER_ID = 'jev';
/** The official endpoint. Similarly named third-party gateways are not TypeSafe. */
export const JEV_BASE_URL = 'https://api.typesafe.ai';
/** The synchronous chat path's total budget for a decision. */
export const JEV_DEFAULT_DEADLINE_MS = 1500;

export interface JevDecisionProviderOptions {
  apiKey: string;
  /** Defaults to the official endpoint. The SDK's environment fallbacks are never used. */
  baseURL?: string;
  /** A pinned model version such as 'jev-1.13.0'. Moving aliases such as 'jev-latest' are refused. */
  model: string;
  fetch?: Fetch;
  /** Total deadline per call in milliseconds, including connecting and reading the body. */
  deadlineMs?: number;
  breaker?: BreakerOptions;
  /** Monotonic milliseconds for the breaker and latency. Default: `performance.now()`. */
  clock?: () => number;
}

const quiet = () => undefined;
const SILENT: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };

/** Settles with the call or when the signal aborts, even if the transport ignores the signal. */
function untilAborted<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Jev (TypeSafe `systemOne`) behind the provider-neutral `DecisionProvider` port (ADR 0006). One
 * attempt per call and no retries; the adapter enforces the total deadline and cancellation itself
 * because the SDK timeout is per attempt. A circuit breaker stops calls while Jev is unavailable.
 * Nothing is logged: SDK logging is off and request and response bodies are never written anywhere.
 */
export function createJevDecisionProvider(options: JevDecisionProviderOptions): DecisionProvider {
  const model = options.model?.trim() ?? '';
  if (!/\d/.test(model) || /latest/i.test(model)) {
    throw new TypeError(`Jev needs a pinned model version such as "jev-1.13.0", not "${model}"`);
  }
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new TypeError('Jev needs an API key');
  }
  const defaultDeadline = options.deadlineMs ?? JEV_DEFAULT_DEADLINE_MS;
  if (!(Number.isFinite(defaultDeadline) && defaultDeadline > 0)) {
    throw new TypeError('deadlineMs must be a positive number');
  }
  const clock = options.clock ?? (() => performance.now());
  const breaker = createCircuitBreaker(
    options.breaker ?? { failureThreshold: 5, cooldownMs: 30_000 },
    clock,
  );
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? JEV_BASE_URL,
    defaultModel: model,
    logLevel: 'off',
    logger: SILENT,
    retry: { maxRetries: 0 },
    timeout: defaultDeadline,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    id: JEV_PROVIDER_ID,
    async decide<const Q extends DecisionQuestions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResult<DecisionAnswers<Q>>> {
      const started = clock();
      const finish = (
        outcome: JevOutcome<DecisionAnswers<Q>>['result'],
      ): DecisionResult<DecisionAnswers<Q>> => {
        const audit: DecisionAudit = {
          provider: JEV_PROVIDER_ID,
          task: request.task,
          rubricVersion: request.rubricVersion,
          latencyMs: Math.max(0, Math.round(clock() - started)),
        };
        if (request.language) audit.language = request.language;
        return { ...audit, ...outcome };
      };

      const problem = validateDecisionRequest(request);
      if (problem) return finish({ status: 'invalid', reason: problem });
      if (request.signal?.aborted) {
        return finish({ status: 'unavailable', retryable: false, reason: 'aborted' });
      }
      const admission = breaker.admit();
      if (!admission.allowed) {
        const after =
          admission.retryAfterMs === undefined ? {} : { retryAfterMs: admission.retryAfterMs };
        return finish({ status: 'unavailable', retryable: true, reason: 'circuit_open', ...after });
      }

      const deadlineMs = Math.ceil(request.deadlineMs ?? defaultDeadline);
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
      let outcome: JevOutcome<DecisionAnswers<Q>>;
      try {
        const call = client.systemOne(
          { state: request.state, questions: toJevQuestions(request.questions), model },
          {
            signal,
            timeout: Math.max(1, deadlineMs - (clock() - started)),
            retry: { maxRetries: 0 },
          },
        );
        const { data, requestId } = await untilAborted(call.withResponse(), signal);
        outcome = readJevResponse(request.questions, data, model, requestId);
      } catch (error) {
        // The combined signal keeps the reason of whichever source aborted first.
        const caller = request.signal;
        outcome = fromJevError(error, {
          callerAborted: caller?.aborted === true && signal.reason === caller.reason,
          deadlinePassed: deadline.aborted,
        });
      }
      breaker.record(outcome.health, admission.probe);
      return finish(outcome.result);
    },
  };
}
