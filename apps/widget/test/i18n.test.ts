import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_NAMES,
  LOCALES,
  type Locale,
  loadResource,
  REPLY_LANGUAGE_NAMES,
  type Resource,
} from '../src/i18n.js';

/** Every language's words, loaded as the chat loads them. */
const resources = Object.fromEntries(
  await Promise.all(LOCALES.map(async (locale) => [locale, await loadResource(locale)] as const)),
) as Record<Locale, Resource>;

/** Every string of a resource tree by its dotted key. */
function flatten(tree: object, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree) as Array<[string, unknown]>) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else if (value && typeof value === 'object') Object.assign(out, flatten(value, path));
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Plural forms (`items_one`, `items_few`…): each language has the forms its grammar needs. */
const PLURAL = /_(zero|one|two|few|many|other)$/;
const baseKey = (key: string) => key.replace(PLURAL, '');
/** Text with letters to translate, not only placeholders, numbers or signs. */
const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{\{\s*\w+\s*\}\}/g, ''));

const english = flatten(resources.en.translation);
const englishBase = new Map(Object.entries(english).map(([key, text]) => [baseKey(key), text]));

// U05: the chat works completely in each launch language.
describe('widget text in every language (U05)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(resources[locale].translation);
      const keys = (tree: Record<string, string>) => [...new Set(Object.keys(tree).map(baseKey))];
      expect(keys(strings).sort()).toEqual(keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        // A plural form may spell the number out ("one item"), so {{count}} is optional there.
        const plural = PLURAL.test(key);
        const used = (value: string) =>
          placeholders(value).filter((name) => !(plural && name === 'count'));
        const source = english[key] ?? englishBase.get(baseKey(key)) ?? '';
        expect(used(text), `${locale}.${key}`).toEqual(used(source));
      }
    });
  }

  it('translates rather than copying the English text', () => {
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const strings = flatten(resources[locale].translation);
      const copied = Object.entries(strings)
        .filter(([key, text]) => text === english[key] && hasWords(text))
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
