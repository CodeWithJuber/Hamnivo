import { describe, expect, it } from 'vitest';
import { aiDraftsAr } from '../src/i18n/ai-drafts/ar';
import { aiDraftsEn } from '../src/i18n/ai-drafts/en';
import { aiDraftsHi } from '../src/i18n/ai-drafts/hi';
import { aiDraftsUr } from '../src/i18n/ai-drafts/ur';

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

const english = flatten(aiDraftsEn);

// AI draft text is merged under `inbox.aiDrafts`; TypeScript requires every key, and this checks
// what the types cannot: the same placeholders and no empty text.
describe('AI draft text in every language', () => {
  for (const [locale, tree] of Object.entries({ ar: aiDraftsAr, hi: aiDraftsHi, ur: aiDraftsUr })) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(tree);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    });
  }
});
