import { describe, expect, it } from 'vitest';
import {
  bidiSegments,
  detectLanguage,
  LANGUAGE_OF_SLICE,
  type LanguageDetection,
  REPLY_LANGUAGES,
  type ReplyLanguage,
  resolveReplyLanguage,
  SLICE_OF_LANGUAGE,
  styleInstructions,
  textDirection,
} from '../src/index.js';
import cases from './fixtures/language-detection.json' with { type: 'json' };

interface DetectionCase {
  text: string;
  language: ReplyLanguage | null;
  candidates: ReplyLanguage[];
  note?: string;
}

describe('detectLanguage', () => {
  it.each(cases as DetectionCase[])('$text', ({ text, language, candidates }) => {
    const detection = detectLanguage(text);
    expect(detection.language).toBe(language);
    expect(detection.candidates).toEqual(candidates);
    expect(detection.ambiguous).toBe(candidates.length > 1);
  });

  it('never reads Hinglish or Roman Urdu as English', () => {
    const latinHindustani = (cases as DetectionCase[]).filter((c) =>
      c.candidates.some((l) => l === 'hi-Latn' || l === 'ur-Latn'),
    );
    expect(latinHindustani.length).toBeGreaterThanOrEqual(8);
    for (const { text } of latinHindustani) {
      const detection = detectLanguage(text);
      expect(detection.language, text).not.toBe('en');
      expect(detection.candidates, text).not.toContain('en');
    }
  });

  it('ignores order numbers, emails, web addresses and amounts', () => {
    expect(detectLanguage('NL-1048 کہاں ہے؟').language).toBe('ur');
    expect(detectLanguage('ayesha@example.com').candidates).toEqual([]);
    expect(detectLanguage('https://shop.example/orders/1048').candidates).toEqual([]);
    expect(detectLanguage('AED 120 1048').candidates).toEqual([]);
  });

  it('reports the script, and mixed scripts', () => {
    expect(detectLanguage('Where is my order?').script).toBe('Latn');
    expect(detectLanguage('أين طلبي؟').script).toBe('Arab');
    expect(detectLanguage('मेरा ऑर्डर कहाँ है?').script).toBe('Deva');
    expect(detectLanguage('مجھے refund چاہیے').script).toBe('mixed');
    expect(detectLanguage('👍').script).toBeNull();
  });
});

describe('resolveReplyLanguage', () => {
  const detected = (text: string): LanguageDetection => detectLanguage(text);
  const ambiguous = detected('Order pay ho gaya, delivery nahi mili');

  it('always follows an explicit choice, even against detection', () => {
    expect(
      resolveReplyLanguage({ explicit: 'ur', detection: detected('Where is my order?') }),
    ).toEqual({ language: 'ur', source: 'explicit', confirm: null });
    expect(resolveReplyLanguage({ explicit: 'hi-Latn', previous: 'en', uiLocale: 'ar' })).toEqual({
      language: 'hi-Latn',
      source: 'explicit',
      confirm: null,
    });
  });

  it('follows a message whose language is clear', () => {
    expect(
      resolveReplyLanguage({
        previous: 'ur',
        uiLocale: 'ur',
        detection: detected('Hello, where is my refund?'),
      }),
    ).toEqual({ language: 'en', source: 'detected', confirm: null });
    expect(resolveReplyLanguage({ detection: detected('أين طلبي؟') }).language).toBe('ar');
  });

  it('keeps the previous language when an ambiguous message fits it', () => {
    expect(resolveReplyLanguage({ previous: 'ur-Latn', detection: ambiguous })).toEqual({
      language: 'ur-Latn',
      source: 'previous',
      confirm: null,
    });
  });

  it('suggests from the interface locale and asks once when the words fit several languages', () => {
    expect(resolveReplyLanguage({ uiLocale: 'ur', detection: ambiguous })).toEqual({
      language: 'ur-Latn',
      source: 'suggested',
      confirm: { suggested: 'ur-Latn', alternatives: ['hi-Latn'] },
    });
    expect(resolveReplyLanguage({ uiLocale: 'hi', detection: ambiguous })).toEqual({
      language: 'hi-Latn',
      source: 'suggested',
      confirm: { suggested: 'hi-Latn', alternatives: ['ur-Latn'] },
    });
    // Asked before: no second prompt.
    expect(resolveReplyLanguage({ uiLocale: 'ur', detection: ambiguous, prompted: true })).toEqual({
      language: 'ur-Latn',
      source: 'suggested',
      confirm: null,
    });
  });

  it('never turns ambiguous Hindustani into English, whatever the locale or history', () => {
    const resolution = resolveReplyLanguage({
      previous: 'en',
      uiLocale: 'en',
      detection: ambiguous,
    });
    expect(resolution.language).toBe('hi-Latn');
    expect(resolution.confirm?.alternatives).toEqual(['ur-Latn']);
  });

  it('falls back to the previous language, then the locale, then English when there are no words', () => {
    const none = detected('👍 1048');
    expect(resolveReplyLanguage({ previous: 'ar', uiLocale: 'hi', detection: none })).toEqual({
      language: 'ar',
      source: 'previous',
      confirm: null,
    });
    expect(resolveReplyLanguage({ uiLocale: 'hi', detection: none })).toEqual({
      language: 'hi',
      source: 'locale',
      confirm: null,
    });
    expect(resolveReplyLanguage({})).toEqual({ language: 'en', source: 'default', confirm: null });
  });

  it('keeps the interface locale independent from the reply language', () => {
    // An Urdu interface does not make an English writer get Urdu replies.
    expect(
      resolveReplyLanguage({ uiLocale: 'ur', detection: detected('Can I change my address?') })
        .language,
    ).toBe('en');
  });
});

describe('language slices', () => {
  it('maps every reply language to a slice and back', () => {
    for (const language of REPLY_LANGUAGES) {
      expect(LANGUAGE_OF_SLICE[SLICE_OF_LANGUAGE[language]]).toBe(language);
    }
    expect(SLICE_OF_LANGUAGE['hi-Latn']).toBe('hinglish');
    expect(SLICE_OF_LANGUAGE['ur-Latn']).toBe('roman-urdu');
  });
});

describe('styleInstructions', () => {
  it('changes wording only and says facts stay the same', () => {
    expect(styleInstructions({})).toEqual([]);
    const lines = styleInstructions({ verbosity: 'concise', tone: 'direct' });
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/Facts, prices, policies/);
  });
});

describe('textDirection', () => {
  it.each([
    ['Hello there', 'ltr'],
    ['مرحبا', 'rtl'],
    ['NL-1048 کہاں ہے؟', 'rtl'],
    ['Order NL-1048 مجھے مل گیا', 'rtl'],
    ['ORDER status please مل', 'ltr'],
    ['मेरा ऑर्डर', 'ltr'],
    ['١٢٣ 456', null],
    ['', null],
  ] as const)('%s → %s', (text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });
});

describe('bidiSegments', () => {
  const isolated = (text: string) =>
    bidiSegments(text)
      .filter((s) => s.isolate)
      .map((s) => s.text);

  it.each([
    ['آرڈر NL-1048 کہاں ہے؟', ['NL-1048']],
    ['رقم الطلب #1048.', ['#1048']],
    ['قیمت AED 120 ہے', ['AED 120']],
    ['قیمت Rs. 1,500 ہے', ['Rs. 1,500']],
    ['ای میل ayesha@example.com پر بھیجیں', ['ayesha@example.com']],
    ['visit https://shop.example/orders/1048, thanks', ['https://shop.example/orders/1048']],
    ['فون +92-300-1234567 پر', ['+92-300-1234567']],
    ['No identifiers here', []],
  ])('%s', (text, expected) => {
    expect(isolated(text)).toEqual(expected);
    // Copying keeps the exact text: the segments join back to the input.
    expect(
      bidiSegments(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });

  it('does not take a currency code out of a longer word', () => {
    expect(isolated('ORDER 1048')).toEqual(['1048']);
  });
});
