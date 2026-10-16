import { describe, expect, it } from 'vitest';
import { reportsAr } from '../src/i18n/reports/ar';
import { reportsEn } from '../src/i18n/reports/en';
import { reportsHi } from '../src/i18n/reports/hi';
import { reportsUr } from '../src/i18n/reports/ur';

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

const english = flatten(reportsEn);

// TypeScript requires every key; this checks what the types cannot: the same placeholders and no
// empty text.
describe('Report text in every language', () => {
  for (const [locale, tree] of Object.entries({ ar: reportsAr, hi: reportsHi, ur: reportsUr })) {
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
