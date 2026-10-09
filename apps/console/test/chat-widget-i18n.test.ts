import { describe, expect, it } from 'vitest';
import { automationsAr } from '../src/i18n/automations/ar';
import { automationsEn } from '../src/i18n/automations/en';
import { automationsHi } from '../src/i18n/automations/hi';
import { automationsUr } from '../src/i18n/automations/ur';
import { chatWidgetAr } from '../src/i18n/chat-widget/ar';
import { chatWidgetEn } from '../src/i18n/chat-widget/en';
import { chatWidgetHi } from '../src/i18n/chat-widget/hi';
import { chatWidgetUr } from '../src/i18n/chat-widget/ur';
import { ticketsAr } from '../src/i18n/tickets/ar';
import { ticketsEn } from '../src/i18n/tickets/en';
import { ticketsHi } from '../src/i18n/tickets/hi';
import { ticketsUr } from '../src/i18n/tickets/ur';
import { DEFAULT_FORM_TEXT, PREVIEW_TEXT } from '../src/lib/setup-data';
import { DEFAULT_FIELD_LABELS } from '../src/lib/widget-forms';

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

/** Text that is the same in every language. */
const SAME_EVERYWHERE = new Set<string>([]);

// The Chat widget page, Automations and the inbox's tickets work completely in each launch language (U05).
// TypeScript already requires every key; this also checks placeholders, empty text and text
// copied from the English.
for (const [name, english, translations] of [
  ['chat widget', chatWidgetEn, { ar: chatWidgetAr, hi: chatWidgetHi, ur: chatWidgetUr }],
  ['tickets', ticketsEn, { ar: ticketsAr, hi: ticketsHi, ur: ticketsUr }],
  ['automations', automationsEn, { ar: automationsAr, hi: automationsHi, ur: automationsUr }],
] as const) {
  const source = flatten(english);
  describe(`the ${name} text in every language`, () => {
    it('English has no empty text', () => {
      expect(Object.entries(source).filter(([, text]) => !text.trim())).toEqual([]);
    });

    for (const [locale, tree] of Object.entries(translations)) {
      const strings = flatten(tree);

      it(`${locale}: every key, the same placeholders, and no empty text`, () => {
        expect(Object.keys(strings).sort()).toEqual(Object.keys(source).sort());
        for (const [key, text] of Object.entries(strings)) {
          expect(text.trim(), `${locale}.${key}`).not.toBe('');
          expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(source[key] ?? ''));
        }
      });

      it(`${locale}: is translated, not copied from the English`, () => {
        const copied = Object.entries(strings)
          .filter(([key, text]) => text === source[key] && !SAME_EVERYWHERE.has(key))
          .map(([key]) => key);
        expect(copied).toEqual([]);
      });
    }
  });
}

describe('the chat’s own words in the preview and on new questions', () => {
  it('are written in every language of the chat, none copied from the English', () => {
    const sets = [
      ...Object.values(DEFAULT_FIELD_LABELS),
      DEFAULT_FORM_TEXT.consent,
      DEFAULT_FORM_TEXT.thanks,
      ...(['prechatIntro', 'offlineIntro', 'startChat', 'send', 'agree', 'optional'] as const).map(
        (key) => ({
          en: PREVIEW_TEXT.en[key],
          ar: PREVIEW_TEXT.ar[key],
          hi: PREVIEW_TEXT.hi[key],
          ur: PREVIEW_TEXT.ur[key],
        }),
      ),
    ];
    for (const texts of sets) {
      for (const lang of ['ar', 'hi', 'ur'] as const) {
        expect(texts[lang].trim(), `${texts.en} (${lang})`).not.toBe('');
        expect(texts[lang], `${texts.en} (${lang})`).not.toBe(texts.en);
      }
    }
  });
});
