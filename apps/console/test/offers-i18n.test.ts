import { describe, expect, it } from 'vitest';
import { offersAr } from '../src/i18n/offers/ar';
import { offersEn } from '../src/i18n/offers/en';
import { offersHi } from '../src/i18n/offers/hi';
import { offersUr } from '../src/i18n/offers/ur';

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

const english = flatten(offersEn);

// Offer text is merged under `inbox.offers`; TypeScript requires every key, and this checks
// what the types cannot: the same placeholders and no empty text.
describe('Offer text in every language', () => {
  for (const [locale, tree] of Object.entries({ ar: offersAr, hi: offersHi, ur: offersUr })) {
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
