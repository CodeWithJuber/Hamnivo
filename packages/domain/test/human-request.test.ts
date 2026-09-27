import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  detectHumanRequest,
  LANGUAGE_SLICES,
  type LanguageSlice,
  normalizeForMatching,
} from '../src/index.js';

interface Case {
  text: string;
  language: LanguageSlice;
  requested: boolean;
  why?: string;
}

const { cases } = JSON.parse(
  readFileSync(new URL('./fixtures/human-requests.json', import.meta.url), 'utf8'),
) as { cases: Case[] };
const positives = cases.filter((c) => c.requested);
const negatives = cases.filter((c) => !c.requested);

describe('detectHumanRequest (fixtures)', () => {
  it('covers every language slice with requests and look-alikes', () => {
    expect(positives.length).toBeGreaterThanOrEqual(25);
    expect(negatives.length).toBeGreaterThanOrEqual(20);
    for (const language of LANGUAGE_SLICES) {
      expect(positives.filter((c) => c.language === language).length).toBeGreaterThanOrEqual(4);
      expect(negatives.filter((c) => c.language === language).length).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(positives)('$language: "$text" is a request', ({ text, language }) => {
    expect(detectHumanRequest(text)).toMatchObject({ requested: true, language });
  });

  it.each(negatives)('$language: "$text" is not a request ($why)', ({ text }) => {
    expect(detectHumanRequest(text)).toEqual({ requested: false });
  });
});

describe('detectHumanRequest', () => {
  it('reports the phrase that matched, normalized', () => {
    expect(detectHumanRequest('Can I SPEAK with a real person?')).toEqual({
      requested: true,
      phrase: 'speak with a real person',
      language: 'en',
    });
    expect(detectHumanRequest('bot nahi, insaan chahiye').phrase).toBe('insan chahiye');
    expect(detectHumanRequest('human   please!!!').phrase).toBe('human please');
  });

  it('treats a message that is only a person noun as a request', () => {
    expect(detectHumanRequest('Agent')).toMatchObject({ requested: true, language: 'en' });
    expect(detectHumanRequest('agent agent agent')).toMatchObject({ requested: true });
    expect(detectHumanRequest('insaan plz')).toMatchObject({ language: 'roman-urdu' });
    expect(detectHumanRequest('انسان')).toMatchObject({ requested: true, language: 'ar' });
    expect(detectHumanRequest('Are you a bot? Human?').requested).toBe(false);
  });

  it('keeps negation inside its clause', () => {
    expect(detectHumanRequest('I dont want the bot. I want a human').requested).toBe(true);
    expect(detectHumanRequest("I don't think I need a human").requested).toBe(false);
    expect(detectHumanRequest('Please do not connect me with an agent').requested).toBe(false);
    expect(detectHumanRequest('no, I want a human').requested).toBe(true);
    expect(detectHumanRequest("Why won't you let me talk to a human?").requested).toBe(true);
    expect(detectHumanRequest('insaan chahiye nahi').requested).toBe(false);
    expect(detectHumanRequest('insaan chahiye, nahi to complaint karunga').requested).toBe(true);
    expect(detectHumanRequest('لا، أريد موظف').requested).toBe(true);
  });

  it('ignores empty input and scans only the edges of very long input', () => {
    expect(detectHumanRequest('')).toEqual({ requested: false });
    expect(detectHumanRequest(' ?! ')).toEqual({ requested: false });
    const filler = 'lorem ipsum '.repeat(2000);
    expect(detectHumanRequest(`${filler} please connect me to an agent`).requested).toBe(true);
    const started = performance.now();
    for (let i = 0; i < 20; i++) detectHumanRequest(filler);
    expect((performance.now() - started) / 20).toBeLessThan(50);
  });
});

describe('normalizeForMatching', () => {
  const same = (a: string, b: string) =>
    expect(normalizeForMatching(a)).toBe(normalizeForMatching(b));

  it('folds Arabic and Urdu letter variants', () => {
    same('ی', 'ي');
    same('ک', 'ك');
    same('ہ', 'ه');
    same('ھ', 'ه');
    same('ة', 'ہ');
    for (const alef of ['أ', 'إ', 'آ']) expect(normalizeForMatching(alef)).toBe('ا');
    same('چاہئے', 'چاہیے');
  });

  it('removes diacritics and tatweel', () => {
    expect(normalizeForMatching('مُوَظَّف')).toBe('موظف');
    expect(normalizeForMatching('مـــوظـــف')).toBe('موظف');
    expect(normalizeForMatching('Café')).toBe('cafe');
  });

  it('folds Devanagari nukta and virama forms', () => {
    same('इंसान', 'इन्सान');
    same('एजेंट', 'एजेन्ट');
    same('ज़रूर', 'जरूर');
    same('फ़ोन', 'फोन');
  });

  it('collapses punctuation, spaces, apostrophes, repeated letters and native digits', () => {
    expect(normalizeForMatching('  Human,   PLEASE!!! ')).toBe('human please');
    expect(normalizeForMatching("I don't")).toBe('i dont');
    expect(normalizeForMatching('insaaan / insan')).toBe('insan insan');
    expect(normalizeForMatching('٥ ۵ ५')).toBe('5 5 5');
    expect(normalizeForMatching('a\u200cb')).toBe('ab');
  });
});
