import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { type ModelErrorKind, type NormalizedModelError, normalizeModelError } from './errors.js';

/** Failures another model may not share. Auth, invalid input and aborts would fail again. */
const FALLBACK_KINDS: ReadonlySet<ModelErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'unavailable',
  'timeout',
]);

// Stream parts that carry nothing a caller would show. They are held back until content arrives.
const STRUCTURAL = new Set<LanguageModelV4StreamPart['type']>([
  'stream-start',
  'response-metadata',
  'raw',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'finish',
]);

export interface FallbackEvent {
  /** `provider/modelId` of the model that failed. */
  from: string;
  /** `provider/modelId` of the model tried next. */
  to: string;
  /** Safe to log. */
  error: NormalizedModelError;
}

export interface FallbackOptions {
  /** Called before the next model is tried, for example to count fallbacks per provider. */
  onFallback?: (event: FallbackEvent) => void;
}

type Reader = ReadableStreamDefaultReader<LanguageModelV4StreamPart>;

interface OpenedStream {
  result: LanguageModelV4StreamResult;
  reader: Reader;
  /** Parts read so far: up to and including the first content or error part. */
  held: LanguageModelV4StreamPart[];
}

const labelOf = (model: LanguageModelV4) => `${model.provider}/${model.modelId}`;

function isContent(part: LanguageModelV4StreamPart): boolean {
  if (part.type === 'text-delta' || part.type === 'reasoning-delta') return part.delta !== '';
  return part.type !== 'error' && !STRUCTURAL.has(part.type);
}

function served(
  metadata: SharedV4ProviderMetadata | undefined,
  model: LanguageModelV4,
  attempts: number,
): SharedV4ProviderMetadata {
  return { ...metadata, hamnivo: { ...metadata?.hamnivo, servedBy: labelOf(model), attempts } };
}

/** Starts a stream and reads it until the first content or error part. */
async function open(model: LanguageModelV4, call: LanguageModelV4CallOptions) {
  const result = await model.doStream(call);
  const reader = result.stream.getReader();
  const held: LanguageModelV4StreamPart[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      held.push(value);
      if (value.type === 'error' || isContent(value)) break;
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  return { result, reader, held } satisfies OpenedStream;
}

/** The held parts, then the rest of the source, with `transform` applied to each part. */
function resume(
  { reader, held }: OpenedStream,
  transform: (part: LanguageModelV4StreamPart) => LanguageModelV4StreamPart,
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of held) controller.enqueue(transform(part));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(transform(value));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * One model that tries `models` in order. It moves to the next model only when a call fails with
 * a rate limit, overload, outage or timeout, and never after the caller aborted. A stream moves on
 * only while it has emitted no content; after that its error reaches the caller unchanged. The
 * serving model is reported in `providerMetadata.hamnivo.servedBy`.
 */
export function withFallback(
  models: LanguageModelV4[],
  options: FallbackOptions = {},
): LanguageModelV4 {
  const [first] = models;
  if (!first) throw new TypeError('withFallback needs at least one model');

  /** Whether to try the model after `models[index]`. Reports the switch when it does. */
  const fallsBack = (error: unknown, index: number, call: LanguageModelV4CallOptions) => {
    const failed = models[index] as LanguageModelV4;
    const next = models[index + 1];
    if (!next || call.abortSignal?.aborted) return false;
    const normalized = normalizeModelError(error, { provider: failed.provider });
    if (!FALLBACK_KINDS.has(normalized.kind)) return false;
    try {
      options.onFallback?.({ from: labelOf(failed), to: labelOf(next), error: normalized });
    } catch {
      // A failing observer must not cost the customer an answer.
    }
    return true;
  };

  return {
    specificationVersion: 'v4',
    provider: 'hamnivo.fallback',
    modelId: models.map(labelOf).join(','),
    // Models may accept different file URLs. With none listed, the AI SDK downloads files and
    // every model receives their data.
    supportedUrls: models.length === 1 ? first.supportedUrls : {},

    async doGenerate(call) {
      for (let index = 0; ; index++) {
        const model = models[index] as LanguageModelV4;
        try {
          const result = await model.doGenerate(call);
          return { ...result, providerMetadata: served(result.providerMetadata, model, index + 1) };
        } catch (error) {
          if (!fallsBack(error, index, call)) throw error;
        }
      }
    },

    async doStream(call) {
      for (let index = 0; ; index++) {
        const model = models[index] as LanguageModelV4;
        let opened: OpenedStream;
        try {
          opened = await open(model, call);
        } catch (error) {
          if (!fallsBack(error, index, call)) throw error;
          continue;
        }
        const last = opened.held.at(-1);
        if (last?.type === 'error' && fallsBack(last.error, index, call)) {
          opened.reader.cancel().catch(() => {});
          continue;
        }
        const stream = resume(opened, (part) =>
          part.type === 'finish'
            ? { ...part, providerMetadata: served(part.providerMetadata, model, index + 1) }
            : part,
        );
        return { ...opened.result, stream };
      }
    },
  };
}
