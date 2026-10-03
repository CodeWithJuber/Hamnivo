import { describe, expect, it } from 'vitest';
import { aiPowerAr } from '../src/i18n/ai-power/ar';
import { aiPowerEn } from '../src/i18n/ai-power/en';
import { aiPowerHi } from '../src/i18n/ai-power/hi';
import { aiPowerUr } from '../src/i18n/ai-power/ur';

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const english = flatten(aiPowerEn);

// The AI power screens work completely in each launch language (U05). TypeScript requires every
// key; this also checks placeholders and empty text, which the types cannot see.
describe('AI power text in every language (U05)', () => {
  for (const [locale, tree] of Object.entries({ ar: aiPowerAr, hi: aiPowerHi, ur: aiPowerUr })) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(tree);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    });
  }

  it('English has no empty text', () => {
    expect(Object.entries(english).filter(([, text]) => text.trim() === '')).toEqual([]);
  });
});
