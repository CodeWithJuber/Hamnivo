import { PERMISSION_KEYS } from '@hamnivo/policy';
import { describe, expect, it } from 'vitest';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { hi } from '../src/i18n/hi';
import { LANGUAGE_NAMES, LOCALES } from '../src/i18n/index';
import { ur } from '../src/i18n/ur';

type Tree = { readonly [key: string]: string | Tree };

/** Every string of a translation tree by its dotted key. */
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

const english = flatten(en);
const translations = { ar, hi, ur } as const;

// U05: Studio works completely in each launch language. TypeScript already requires every key;
// this also checks placeholders and empty text, which the types cannot see.
describe('Studio text in every language (U05)', () => {
  for (const [locale, tree] of Object.entries(translations)) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(tree);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    });

    it(`${locale}: says the translation awaits native review`, () => {
      // English is the source; every other language shows the review note until reviewed.
      expect(flatten(tree)['app.translationNote']).not.toBe('');
    });
  }

  it('English has no empty text except the review note', () => {
    const empty = Object.entries(english)
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual(['app.translationNote']);
  });

  it('names each language in itself', () => {
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LOCALES].sort());
  });
});

// Team and access (board 22) lists every permission of the catalog. A permission added to
// @hamnivo/policy without a label would show its English description in every language.
describe('permission labels', () => {
  it('every permission in the catalog has a label', () => {
    const missing = PERMISSION_KEYS.filter((key) => english[`permissions.${key}`] === undefined);
    expect(missing).toEqual([]);
  });

  it('every permission area has a name', () => {
    const areas = [...new Set(PERMISSION_KEYS.map((key) => key.split('.')[0]))];
    expect(areas.filter((area) => english[`permissionAreas.${area}`] === undefined)).toEqual([]);
  });

  it('no label is left for a permission the catalog no longer has', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    const stale = Object.keys(english)
      .filter((key) => key.startsWith('permissions.'))
      .map((key) => key.slice('permissions.'.length))
      .filter((key) => !known.has(key));
    expect(stale).toEqual([]);
  });
});
