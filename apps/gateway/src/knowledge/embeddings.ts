import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import { createEmbeddingModel, type ModelSpec } from '@hamnivo/adapters/models';
import { EMBEDDING_DIMENSIONS } from '@hamnivo/db/schema';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { embedMany } from 'ai';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/** Test hook: when provided, knowledge is embedded with this model. */
export const EMBEDDING_MODEL = Symbol('EMBEDDING_MODEL');

/** The platform embedding spec, with the platform key for its provider. */
function embeddingSpec(config: AppConfig): ModelSpec {
  const base = { provider: config.EMBEDDING_PROVIDER, modelId: config.EMBEDDING_MODEL } as const;
  switch (config.EMBEDDING_PROVIDER) {
    case 'openai':
      return { ...base, ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}) };
    case 'google':
      return {
        ...base,
        ...(config.GOOGLE_GENERATIVE_AI_API_KEY
          ? { apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY }
          : {}),
      };
    case 'openai-compatible':
      return {
        ...base,
        ...(config.OPENAI_COMPATIBLE_BASE_URL
          ? { baseURL: config.OPENAI_COMPATIBLE_BASE_URL }
          : {}),
        ...(config.OPENAI_COMPATIBLE_API_KEY ? { apiKey: config.OPENAI_COMPATIBLE_API_KEY } : {}),
      };
    case 'mock':
      return base;
  }
}

/**
 * The embedding model for knowledge (platform-wide: EMBEDDING_PROVIDER / EMBEDDING_MODEL, keys from
 * the platform model keys). Chunks remember which model embedded them, and search compares only
 * vectors from the current model, so changing the model means re-indexing, never mixing.
 */
@Injectable()
export class EmbeddingFactory {
  private readonly model: EmbeddingModelV4;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Optional() @Inject(EMBEDDING_MODEL) override?: EmbeddingModelV4,
  ) {
    this.model = override ?? createEmbeddingModel(embeddingSpec(config));
  }

  /** `provider:model`, stored with each chunk. */
  get id(): string {
    return `${this.model.provider}:${this.model.modelId}`;
  }

  /**
   * Cosine distance above which a passage is no vector match at all. The offline mock only
   * matches shared words, so it accepts any overlap.
   */
  get maxDistance(): number {
    return this.model.provider === 'mock' ? 0.95 : 0.7;
  }

  async embed(values: string[], abortSignal?: AbortSignal): Promise<number[][]> {
    if (values.length === 0) return [];
    const { embeddings } = await embedMany({
      model: this.model,
      values,
      maxRetries: 1,
      // Stored vectors have a fixed size; models that can shorten their output are asked to.
      providerOptions: {
        openai: { dimensions: EMBEDDING_DIMENSIONS },
        google: { outputDimensionality: EMBEDDING_DIMENSIONS },
      },
      ...(abortSignal ? { abortSignal } : {}),
    });
    for (const vector of embeddings) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `The embedding model returned ${vector.length} dimensions; ${EMBEDDING_DIMENSIONS} are stored.`,
        );
      }
    }
    return embeddings;
  }
}
