import type { EmbeddingModelV4, EmbeddingModelV4Embedding } from '@ai-sdk/provider';

export interface MockEmbeddingOptions {
  /** Vector length. */
  dimensions?: number;
  modelId?: string;
}

// Short vowels, Quranic annotation marks and tatweel are optional in Arabic script.
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
// Hamza and madda over or under alef are often left out when typing.
const ALEF_FORMS = /[آأإٱ]/g;
// Letters, combining marks (Devanagari vowel signs) and digits. ZWNJ and ZWJ join parts of one
// Urdu or Persian word, so they stay inside the word and are then dropped.
const WORD = /[\p{L}\p{M}\p{N}‌‍]+/gu;
const JOINERS = /[‌‍]/g;
// Gives text without words a vector too, so every vector has unit length.
const EMPTY = '\u0000';

const encoder = new TextEncoder();

/** Normalized words of a text, the features the mock model hashes. */
export function mockEmbeddingWords(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_FORMS, 'ا');
  return (normalized.match(WORD) ?? [])
    .map((word) => word.replace(JOINERS, ''))
    .filter((word) => word !== '');
}

/** 32-bit FNV-1a over UTF-8 bytes: stable across runtimes and releases. */
function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(word)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embed(text: string, dimensions: number): EmbeddingModelV4Embedding {
  const vector = new Array<number>(dimensions).fill(0);
  const words = mockEmbeddingWords(text);
  for (const word of words.length > 0 ? words : [EMPTY]) {
    const index = fnv1a(word) % dimensions;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return vector.map((value) => value / norm);
}

/**
 * `hamnivo-mock-embedding`: deterministic, offline embeddings by feature hashing of normalized
 * words into an L2-normalized vector. The same text always gets the same vector, and texts that
 * share words have a higher cosine similarity, so retrieval tests can rank results. It works on
 * any script, including Arabic, Urdu and Devanagari. It captures shared words, not meaning.
 */
export function createMockEmbeddingModel(options: MockEmbeddingOptions = {}): EmbeddingModelV4 {
  const dimensions = options.dimensions ?? 768;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError('dimensions must be a positive integer');
  }
  return {
    specificationVersion: 'v4',
    provider: 'hamnivo',
    modelId: options.modelId ?? 'hamnivo-mock-embedding',
    maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
      abortSignal?.throwIfAborted();
      let tokens = 0;
      const embeddings = values.map((value) => {
        tokens += mockEmbeddingWords(value).length;
        return embed(value, dimensions);
      });
      return { embeddings, usage: { tokens }, warnings: [] };
    },
  };
}
