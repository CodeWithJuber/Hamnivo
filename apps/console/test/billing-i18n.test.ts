import { describe, expect, it } from 'vitest';
import { billingAr } from '../src/i18n/billing/ar';
import { billingEn } from '../src/i18n/billing/en';
import { billingHi } from '../src/i18n/billing/hi';
import { billingUr } from '../src/i18n/billing/ur';

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

const english = flatten(billingEn);

// Plan and billing (SaaS) text is merged under `billing`; TypeScript requires every key, and this
// checks what the types cannot: the same placeholders and no empty text.
describe('Plan and billing text in every language', () => {
  for (const [locale, tree] of Object.entries({ ar: billingAr, hi: billingHi, ur: billingUr })) {
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
