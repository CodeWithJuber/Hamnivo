import { cosineSimilarity, embed, embedMany } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  createEmbeddingModel,
  createMockEmbeddingModel,
  mockEmbeddingWords,
} from '../../src/models/index.js';

const model = createMockEmbeddingModel();

async function vectors(values: string[], embeddingModel = model) {
  const { embeddings } = await embedMany({ model: embeddingModel, values, maxRetries: 0 });
  return embeddings;
}

const norm = (vector: number[]) => Math.hypot(...vector);

/** Index of the document most similar to the query. */
async function nearest(query: string, documents: string[]) {
  const [q, ...docs] = await vectors([query, ...documents]);
  const scores = docs.map((doc) => cosineSimilarity(q as number[], doc));
  return scores.indexOf(Math.max(...scores));
}

describe('hamnivo-mock-embedding', () => {
  it('gives the same text the same unit vector, 768 values by default', async () => {
    const [a, b] = await vectors(['Where is my order?', 'Where is my order?']);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b);
    expect(norm(a as number[])).toBeCloseTo(1, 12);
  });

  it('is stable across model instances and releases', async () => {
    const [vector] = await vectors(['order'], createMockEmbeddingModel({ dimensions: 16 }));
    // FNV-1a("order") % 16 = 7; a change here changes every stored mock vector.
    expect(vector?.indexOf(1)).toBe(7);
  });

  it('honours dimensions and rejects bad ones', async () => {
    const [vector] = await vectors(['hello'], createMockEmbeddingModel({ dimensions: 32 }));
    expect(vector).toHaveLength(32);
    expect(() => createMockEmbeddingModel({ dimensions: 0 })).toThrow(RangeError);
    expect(() => createMockEmbeddingModel({ dimensions: 1.5 })).toThrow(RangeError);
  });

  it('puts texts that share words closer together', async () => {
    const [query, related, unrelated] = await vectors([
      'order status',
      'order status and tracking',
      'reset your password',
    ]);
    expect(cosineSimilarity(query as number[], related as number[])).toBeGreaterThan(0.5);
    expect(cosineSimilarity(query as number[], unrelated as number[])).toBeLessThan(0.2);
  });

  it('ignores case, punctuation and Unicode compatibility forms', async () => {
    const [a, b] = await vectors(['ORDER #1042, please!', 'order 1042 please']);
    expect(a).toEqual(b);
  });

  it('retrieves in English, Arabic, Urdu and Hindi', async () => {
    const documents = [
      'Track your order status from the orders page',
      'تتبع حالة طلبك من صفحة الطلبات',
      'اپنے آرڈر کی حالت آرڈرز کے صفحے پر دیکھیں',
      'अपने ऑर्डर की स्थिति ऑर्डर पेज पर देखें',
      'Reset your password from the sign in page',
      'أعد تعيين كلمة المرور من صفحة الدخول',
      'پاس ورڈ سائن ان صفحے سے تبدیل کریں',
      'साइन इन पेज से पासवर्ड बदलें',
    ];
    expect(await nearest('order status', documents)).toBe(0);
    expect(await nearest('حالة طلبك', documents)).toBe(1);
    expect(await nearest('آرڈر کی حالت', documents)).toBe(2);
    expect(await nearest('ऑर्डर की स्थिति', documents)).toBe(3);
    expect(await nearest('पासवर्ड बदलें', documents)).toBe(7);
  });

  it('splits words by Unicode letters and keeps Devanagari vowel signs', () => {
    expect(mockEmbeddingWords('मेरा ऑर्डर कहाँ है?')).toEqual(['मेरा', 'ऑर्डर', 'कहाँ', 'है']);
    expect(mockEmbeddingWords('میرا آرڈر کہاں ہے؟')).toEqual(['میرا', 'ارڈر', 'کہاں', 'ہے']);
    expect(mockEmbeddingWords('Hello, world! 1042')).toEqual(['hello', 'world', '1042']);
  });

  it('matches Arabic with or without short vowels, tatweel and hamza on alef', () => {
    expect(mockEmbeddingWords('أَيْنَ طَلَبِي')).toEqual(mockEmbeddingWords('اين طلبي'));
    expect(mockEmbeddingWords('طـــلب')).toEqual(['طلب']);
  });

  it('keeps a word joined by ZWNJ together', () => {
    expect(mockEmbeddingWords('می‌خواهم')).toEqual(['میخواهم']);
  });

  it('gives text without words a unit vector too', async () => {
    const [empty, dots] = await vectors(['', '...']);
    expect(norm(empty as number[])).toBeCloseTo(1, 12);
    expect(empty).toEqual(dots);
  });

  it('counts words as usage and respects cancellation', async () => {
    const result = await embed({ model, value: 'Where is my order?', maxRetries: 0 });
    expect(result.usage.tokens).toBe(4);
    const controller = new AbortController();
    controller.abort();
    await expect(
      model.doEmbed({ values: ['x'], abortSignal: controller.signal }),
    ).rejects.toThrow();
  });

  it('is what the registry returns for the mock provider', async () => {
    const fromRegistry = createEmbeddingModel({
      provider: 'mock',
      modelId: 'hamnivo-mock-embedding',
    });
    expect(fromRegistry.modelId).toBe('hamnivo-mock-embedding');
    expect(await vectors(['same'], fromRegistry)).toEqual(await vectors(['same']));
  });
});
