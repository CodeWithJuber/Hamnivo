import { describe, expect, it } from 'vitest';
import { inboxAlertsAr } from '../src/i18n/inbox-alerts/ar';
import { inboxAlertsEn } from '../src/i18n/inbox-alerts/en';
import { inboxAlertsHi } from '../src/i18n/inbox-alerts/hi';
import { inboxAlertsUr } from '../src/i18n/inbox-alerts/ur';

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

const english = flatten(inboxAlertsEn);

// The inbox text works completely in each launch language. TypeScript already requires every key;
// this also checks placeholders and empty text, which the types cannot see.
describe('inbox text in every language', () => {
  for (const [locale, tree] of Object.entries({
    ar: inboxAlertsAr,
    hi: inboxAlertsHi,
    ur: inboxAlertsUr,
  })) {
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
