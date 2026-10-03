import { describe, expect, it } from 'vitest';
import { setupAr } from '../src/i18n/setup/ar';
import { setupEn } from '../src/i18n/setup/en';
import { setupHi } from '../src/i18n/setup/hi';
import { setupUr } from '../src/i18n/setup/ur';

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

/** `{{name}}` placeholders of i18next, and the chat’s own `{when}` token. */
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const tokens = (text: string) =>
  [...text.replace(/\{\{[^}]*\}\}/g, '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const english = flatten(setupEn);

/** Text that is the same in every language: product names, and the unit of a length in pixels. */
const SAME_EVERYWHERE = new Set([
  'models.server.jev',
  'appearance.radius.value',
  'install.platforms.wordpress',
  'install.platforms.woocommerce',
  'install.platforms.shopify',
  'install.platforms.whmcs',
  'install.platforms.wix',
  'install.platforms.squarespace',
  'install.platforms.webflow',
  'install.platforms.google-tag-manager',
  'install.platforms.react',
  'install.platforms.vue',
  'install.platforms.nextjs',
]);

// The setup guide works completely in each launch language (U05). TypeScript already requires
// every key; this also checks placeholders and empty text, which the types cannot see.
describe('the setup text in every language', () => {
  const translations = { ar: setupAr, hi: setupHi, ur: setupUr } as const;

  for (const [locale, tree] of Object.entries(translations)) {
    const strings = flatten(tree);

    it(`${locale}: every key, and no empty text`, () => {
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
      }
    });

    it(`${locale}: the same placeholders as the English`, () => {
      for (const [key, text] of Object.entries(strings)) {
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
        expect(tokens(text), `${locale}.${key}`).toEqual(tokens(english[key] ?? ''));
      }
    });

    it(`${locale}: is translated, not copied from the English`, () => {
      const copied = Object.entries(strings)
        .filter(([key, text]) => text === english[key] && !SAME_EVERYWHERE.has(key))
        .map(([key]) => key);
      expect(copied).toEqual([]);
    });
  }

  it('English has no empty text', () => {
    const empty = Object.entries(english)
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it('keeps the offline message token where the chat fills in the time people are back', () => {
    for (const [locale, tree] of Object.entries({ en: setupEn, ...translations })) {
      expect(flatten(tree)['appearance.offline.hint'], locale).toContain('{when}');
    }
  });
});
