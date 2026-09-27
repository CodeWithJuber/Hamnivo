import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, LOCALES, REPLY_LANGUAGE_NAMES, resources } from '../src/i18n.js';

type Tree = { readonly [key: string]: string | Tree };

/** Every string of a resource tree by its dotted key. */
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

const english = flatten(resources.en.translation);

// U05: the chat works completely in each launch language.
describe('widget text in every language (U05)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(resources[locale].translation);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    });
  }

  it('translates rather than copying the English text', () => {
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const strings = flatten(resources[locale].translation);
      const copied = Object.entries(strings)
        .filter(([key, text]) => text === english[key])
        .map(([key]) => key);
      expect(copied, locale).toEqual([]);
    }
  });

  it('names each interface and reply language in itself', () => {
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(REPLY_LANGUAGE_NAMES).sort()).toEqual(
      ['ar', 'en', 'hi', 'hi-Latn', 'ur', 'ur-Latn'].sort(),
    );
    // Hinglish and Roman Urdu are their own choices, never shown as English.
    expect(REPLY_LANGUAGE_NAMES['hi-Latn']).not.toBe(REPLY_LANGUAGE_NAMES.en);
    expect(REPLY_LANGUAGE_NAMES['ur-Latn']).not.toBe(REPLY_LANGUAGE_NAMES.en);
  });
});
