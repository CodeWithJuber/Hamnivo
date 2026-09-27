import { createHash } from 'node:crypto';
import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import { EMBEDDING_DIMENSIONS } from '@hamnivo/db/schema';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { embedMany } from 'ai';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/** Test hook: when provided, knowledge is embedded with this model. */
export const EMBEDDING_MODEL = Symbol('EMBEDDING_MODEL');

/**
 * Deterministic offline embeddings: hashed word features, L2-normalized. Texts that share words
 * are close, which is enough for development and tests; it understands no meaning.
 */
export function hashingEmbeddingModel(modelId = 'hamnivo-embed'): EmbeddingModelV4 {
  const embed = (text: string): number[] => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const words =
      text
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    for (const word of words) {
      const digest = createHash('sha256').update(word).digest();
      const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
      vector[index] = (vector[index] ?? 0) + ((digest[4] ?? 0) & 1 ? 1 : -1);
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((v) => v / norm);
  };
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId,
    maxEmbeddingsPerCall: 256,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map(embed),
        usage: { tokens: values.reduce((n, v) => n + v.split(/\s+/).length, 0) },
        warnings: [],
      };
    },
  };
}

/**
 * The embedding model for knowledge (platform-wide, EMBEDDING_PROVIDER / EMBEDDING_MODEL). Chunks
 * remember which model embedded them; search compares only vectors from the current model.
 */
@Injectable()
export class EmbeddingFactory {
  private readonly model: EmbeddingModelV4;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Optional() @Inject(EMBEDDING_MODEL) override?: EmbeddingModelV4,
  ) {
    if (override) this.model = override;
    else if (config.EMBEDDING_PROVIDER === 'mock') {
      this.model = hashingEmbeddingModel(config.EMBEDDING_MODEL);
    } else {
      throw new Error(
        `EMBEDDING_PROVIDER=${config.EMBEDDING_PROVIDER} is not available in this build yet.`,
      );
    }
  }

  /**
   * Cosine distance above which a passage is no vector match at all. Hashed words only match
   * shared words, so the offline model accepts any overlap.
   */
  get maxDistance(): number {
    return this.model.provider === 'mock' ? 0.95 : 0.7;
  }

  /** `provider:model`, stored with each chunk. */
  get id(): string {
    return `${this.model.provider}:${this.model.modelId}`;
  }

  async embed(values: string[], abortSignal?: AbortSignal): Promise<number[][]> {
    if (values.length === 0) return [];
    const { embeddings } = await embedMany({
      model: this.model,
      values,
      maxRetries: 1,
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
