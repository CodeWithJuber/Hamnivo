import type { LanguageSlice } from './decisions.js';
import { normalizeForMatching } from './human-request.js';

/**
 * Language preferences (U01, U02, blueprint §26). Interface locale, reply language, script, style
 * and time zone are separate settings: a customer can read the widget in Urdu and write in
 * English. An explicit choice always wins over detection. Detection is per message, deterministic
 * and honest about ambiguity: Hinglish and Roman Urdu are Latin-script Hindustani, not English, and
 * most short messages cannot tell the two apart. Names and addresses never decide a language.
 */

/** Interface locales the widget and Studio ship. */
export const UI_LOCALES = ['en', 'ar', 'hi', 'ur'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** Reply languages as BCP 47 tags. Hinglish is `hi-Latn` and Roman Urdu `ur-Latn`. */
export const REPLY_LANGUAGES = ['en', 'ar', 'hi', 'ur', 'hi-Latn', 'ur-Latn'] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

export type ScriptCode = 'Latn' | 'Arab' | 'Deva';

export const isUiLocale = (value: unknown): value is UiLocale =>
  typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
export const isReplyLanguage = (value: unknown): value is ReplyLanguage =>
  typeof value === 'string' && (REPLY_LANGUAGES as readonly string[]).includes(value);

/** The evaluation and threshold slice of a reply language. */
export const SLICE_OF_LANGUAGE: Readonly<Record<ReplyLanguage, LanguageSlice>> = {
  en: 'en',
  ar: 'ar',
  hi: 'hi',
  ur: 'ur',
  'hi-Latn': 'hinglish',
  'ur-Latn': 'roman-urdu',
};

export const LANGUAGE_OF_SLICE: Readonly<Record<LanguageSlice, ReplyLanguage>> = {
  en: 'en',
  ar: 'ar',
  hi: 'hi',
  ur: 'ur',
  hinglish: 'hi-Latn',
  'roman-urdu': 'ur-Latn',
};

export const SCRIPT_OF_LANGUAGE: Readonly<Record<ReplyLanguage, ScriptCode>> = {
  en: 'Latn',
  ar: 'Arab',
  hi: 'Deva',
  ur: 'Arab',
  'hi-Latn': 'Latn',
  'ur-Latn': 'Latn',
};

/** English names, for prompts and logs (interfaces translate their own). */
export const LANGUAGE_NAMES: Readonly<Record<ReplyLanguage, string>> = {
  en: 'English',
  ar: 'Arabic',
  hi: 'Hindi',
  ur: 'Urdu',
  'hi-Latn': 'Hinglish (Hindi in Latin letters)',
  'ur-Latn': 'Roman Urdu (Urdu in Latin letters)',
};

/** The reply language a UI locale suggests when nothing better is known. */
const LANGUAGE_OF_LOCALE: Readonly<Record<UiLocale, ReplyLanguage>> = {
  en: 'en',
  ar: 'ar',
  hi: 'hi',
  ur: 'ur',
};

// ---------------------------------------------------------------------------------------------
// Scripts and identifiers

const ARABIC_LETTER = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u;
const HEBREW_LETTER = /[\u0590-\u05ff]/u;
const DEVANAGARI_LETTER = /[\u0900-\u097f]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;

/**
 * Tokens whose reading order is fixed left to right whatever surrounds them: web addresses,
 * emails, order and phone numbers, amounts and codes. They never count as words of a language.
 */
const isIdentifier = (token: string) =>
  /\p{N}|@|:\/\/|^www\./iu.test(token) || /^[A-Z]{2,}[-_][A-Z0-9_-]+$/u.test(token);

/** Arabic-script letters Urdu uses and Arabic does not. */
const URDU_LETTERS = /[ٹڈڑںےۓھہۂۃکگپچژی]/gu;
/** Arabic letters and forms Urdu does not use (teh marbuta, alef maksura, Arabic yeh and kaf). */
const ARABIC_LETTERS = /[ةىيكإأؤ]/gu;

const words = (list: readonly string[]) => new Set(list.map(normalizeForMatching));

const URDU_WORDS = words([
  ...['ہے', 'ہیں', 'میں', 'کا', 'کی', 'کے', 'نہیں', 'آپ', 'کیا', 'اور', 'سے', 'کو', 'مجھے'],
  ...['میرا', 'میری', 'تھا', 'گیا', 'گئی', 'رہا', 'رہی', 'چاہیے', 'بھی', 'ابھی', 'کب'],
  ...['کہاں', 'کیوں', 'کیسے', 'یہ', 'وہ', 'لیکن', 'شکریہ', 'براہ', 'کرم', 'پیسے'],
]);
const ARABIC_WORDS = words([
  ...['في', 'من', 'على', 'هل', 'لا', 'أن', 'إلى', 'الى', 'ما', 'هذا', 'هذه', 'لم', 'لن'],
  ...['أريد', 'اريد', 'كيف', 'متى', 'أين', 'اين', 'لماذا', 'شكرا', 'شكراً', 'طلبي', 'مع', 'عن'],
  ...['التي', 'الذي', 'كان', 'لقد', 'قد', 'أنا', 'انا', 'نعم', 'ليس', 'عندي'],
]);

// Latin-script Hindustani (Hinglish and Roman Urdu). Only words English does not use count fully;
// short particles that clash with English or slang count half.
const HINDUSTANI_STRONG = words([
  ...['hai', 'hain', 'nahi', 'nahin', 'nhi', 'nai', 'kya', 'kyun', 'kyon', 'kyu', 'kaise'],
  ...['kaisa', 'kaisi', 'kab', 'kahan', 'kidhar', 'mujhe', 'mujhko', 'mera', 'meri'],
  ...['aap', 'aapka', 'aapki', 'aapke', 'apka', 'apki', 'apke', 'tum', 'tumhara', 'hamara'],
  ...['hamari', 'hoon', 'hun', 'tha', 'thi', 'gaya', 'gayi', 'gya', 'gyi', 'karo', 'karna'],
  ...['karni', 'karein', 'kijiye', 'kiya', 'kiye', 'raha', 'rahi', 'rahe', 'chahiye'],
  ...['chahie', 'chaiye', 'bhi', 'abhi', 'jaldi', 'theek', 'thik', 'accha', 'acha', 'achha'],
  ...['haan', 'yaar', 'bhai', 'bhaiya', 'wapas', 'vapas', 'kuch', 'bahut', 'bohat', 'bohot'],
  ...['zyada', 'ziada', 'lekin', 'magar', 'aur', 'agar', 'toh', 'wala', 'wali', 'mila', 'mili'],
  ...['diya', 'liya', 'batao', 'bataye', 'bataiye', 'bataen', 'samajh', 'koi', 'kisi', 'kaun'],
  ...['kitna', 'kitne', 'kitni', 'mein', 'hua', 'hui', 'sakta'],
  ...['sakti', 'sakte', 'paise', 'paisa', 'abhi', 'kal', 'aaj', 'kyunki', 'kyunke', 'shukriya'],
  ...['dhanyavaad', 'dhanyavad', 'dhanyawad', 'kripya', 'kripaya', 'meherbani', 'mehrbani'],
  ...['janab', 'bilkul', 'zaroor', 'zaroori', 'masla', 'insaan', 'banda', 'bande', 'hoga'],
  ...['hogi', 'honge', 'dijiye', 'dijie', 'chahta', 'chahti', 'chahte', 'pata'],
]);
const HINDUSTANI_WEAK = words([
  ...['ho', 'se', 'ko', 'ka', 'ki', 'ke', 'ji', 'pe', 'par', 'ya', 'main', 'mere', 'hue', 'mile'],
  ...['dena', 'lena'],
]);
/** Spellings and words that lean to Urdu, or to Hindi, when written in Latin letters. */
const ROMAN_URDU_LEAN = words([
  ...['bohat', 'bohot', 'kyunke', 'kiun', 'meherbani', 'mehrbani', 'janab', 'masla', 'masail'],
  ...['shukriya', 'shukria', 'insaan', 'khuda', 'taqreeban', 'maloomat', 'darkhwast', 'wazeh'],
  ...['mutaliq', 'ittila', 'tashreef', 'ijazat', 'sakoon', 'baraye', 'numainda', 'zahir'],
]);
const HINGLISH_LEAN = words([
  ...['bahut', 'kyunki', 'kripya', 'kripaya', 'dhanyavaad', 'dhanyavad', 'dhanyawad', 'samasya'],
  ...['vyakti', 'prashn', 'uttar', 'jaankari', 'jankari', 'sahayata', 'suvidha', 'turant'],
  ...['namaste', 'avashya', 'prapt', 'bhugtan', 'shubh', 'seva', 'grahak'],
]);
const ENGLISH_WORDS = words([
  ...['the', 'is', 'are', 'was', 'were', 'am', 'be', 'been', 'my', 'your', 'you', 'i', 'me'],
  ...['we', 'it', 'this', 'that', 'what', 'where', 'when', 'why', 'how', 'who', 'which'],
  ...['please', 'can', 'could', 'would', 'will', 'have', 'has', 'had', 'do', 'does', 'did'],
  ...['not', 'no', 'yes', 'and', 'or', 'but', 'for', 'with', 'of', 'in', 'on', 'at', 'from'],
  ...['an', 'a', 'to', 'if', 'there', 'they', 'them', 'our', 'us', 'thanks', 'thank', 'hello'],
  ...['still', 'yet', 'about', 'want', 'need', 'get', 'got', 'should', 'any', 'some', 'just'],
]);

export interface LanguageDetection {
  /** The language when the text shows one clearly; null when it is ambiguous or has no words. */
  language: ReplyLanguage | null;
  /** Languages the text is consistent with, most likely first. Empty when it has no words. */
  candidates: ReplyLanguage[];
  /** The main script of the words, `mixed` when a second script has a large share, or null. */
  script: ScriptCode | 'mixed' | null;
  /** More than one language fits and nothing in the text tells them apart. */
  ambiguous: boolean;
}

interface Tally {
  arab: number;
  deva: number;
  latn: number;
}

function tokensOf(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/[\s\u200b-\u200f\u2060]+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}#+@]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token !== '' && !isIdentifier(token));
}

function tally(tokens: readonly string[]): Tally {
  const counts: Tally = { arab: 0, deva: 0, latn: 0 };
  for (const token of tokens) {
    for (const char of token) {
      if (ARABIC_LETTER.test(char) && !MARK.test(char)) counts.arab += 1;
      else if (DEVANAGARI_LETTER.test(char) && !MARK.test(char)) counts.deva += 1;
      else if (LATIN_LETTER.test(char)) counts.latn += 1;
    }
  }
  return counts;
}

const result = (
  candidates: ReplyLanguage[],
  script: LanguageDetection['script'],
): LanguageDetection => ({
  language: candidates.length === 1 ? (candidates[0] ?? null) : null,
  candidates,
  script,
  ambiguous: candidates.length > 1,
});

function arabicScript(text: string, normalized: readonly string[]): ReplyLanguage[] {
  const urduLetters = text.match(URDU_LETTERS)?.length ?? 0;
  const arabicLetters = text.match(ARABIC_LETTERS)?.length ?? 0;
  const urduWords = normalized.filter((w) => URDU_WORDS.has(w)).length;
  const arabicWords = normalized.filter((w) => ARABIC_WORDS.has(w)).length;
  const urdu = urduLetters + 2 * urduWords;
  const arabic = arabicLetters + 2 * arabicWords;
  if (urdu > arabic) return ['ur'];
  if (arabic > urdu) return ['ar'];
  return ['ar', 'ur'];
}

function latinScript(normalized: readonly string[]): ReplyLanguage[] {
  let hindustani = 0;
  let english = 0;
  let urduLean = 0;
  let hindiLean = 0;
  for (const word of normalized) {
    if (HINDUSTANI_STRONG.has(word)) hindustani += 1;
    else if (HINDUSTANI_WEAK.has(word)) hindustani += 0.5;
    if (ENGLISH_WORDS.has(word)) english += 1;
    if (ROMAN_URDU_LEAN.has(word)) urduLean += 1;
    if (HINGLISH_LEAN.has(word)) hindiLean += 1;
  }
  // Code-switching is normal ("Order pay ho gaya, delivery nahi mili"): Hindustani grammar words
  // decide it, even among English nouns. One Hindustani word alone ("shukriya") is not English.
  const isHindustani =
    (hindustani >= 1.5 && hindustani * 2 >= english) || (hindustani >= 1 && english === 0);
  if (!isHindustani) return english >= 1 ? ['en'] : [];
  if (urduLean > hindiLean) return hindustani >= 1.5 ? ['ur-Latn'] : ['ur-Latn', 'hi-Latn'];
  if (hindiLean > urduLean) return hindustani >= 1.5 ? ['hi-Latn'] : ['hi-Latn', 'ur-Latn'];
  return ['hi-Latn', 'ur-Latn'];
}

/**
 * Detects the language of one message from its words. Identifiers (order numbers, emails, web
 * addresses, amounts) are ignored, so "NL-1048 کہاں ہے؟" is Urdu. The result lists every language
 * the text fits; `ambiguous` says when the text alone cannot choose.
 */
export function detectLanguage(text: string): LanguageDetection {
  const tokens = tokensOf(text);
  const counts = tally(tokens);
  const total = counts.arab + counts.deva + counts.latn;
  if (total === 0) return result([], null);
  const ranked = (Object.entries(counts) as [keyof Tally, number][]).sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  const main = first?.[0] ?? 'latn';
  const mixed = (second?.[1] ?? 0) >= total * 0.25;
  const script: LanguageDetection['script'] = mixed
    ? 'mixed'
    : main === 'arab'
      ? 'Arab'
      : main === 'deva'
        ? 'Deva'
        : 'Latn';
  const normalized = tokens.map(normalizeForMatching).flatMap((t) => t.split(' '));
  switch (main) {
    case 'deva':
      return result(['hi'], script);
    case 'arab':
      return result(arabicScript(text, normalized), script);
    default:
      return result(latinScript(normalized), script);
  }
}

// ---------------------------------------------------------------------------------------------
// Preference resolution

export type LanguageSource =
  | 'explicit'
  | 'detected'
  /** A decision provider chose among the languages the words fit, sure enough for that language. */
  | 'decided'
  | 'suggested'
  | 'previous'
  | 'locale'
  | 'default';

export interface LanguagePreferenceInput {
  /** The customer's own choice. It wins over everything else. */
  explicit?: ReplyLanguage | null;
  /** The language of the previous replies, if any. */
  previous?: ReplyLanguage | null;
  /** The widget's interface locale. A weak signal: it is used only when the words say nothing. */
  uiLocale?: UiLocale | null;
  /** Detection of the customer's latest message. */
  detection?: LanguageDetection | null;
  /** The customer was already asked to confirm an ambiguous language; never ask twice. */
  prompted?: boolean;
  /**
   * A decision provider's choice among the detection's candidates, already held to its
   * threshold. It settles an ambiguous message, so the customer is not asked; it never overrides
   * an explicit choice.
   */
  decided?: ReplyLanguage | null;
}

export interface LanguageResolution {
  language: ReplyLanguage;
  source: LanguageSource;
  /** Ask the customer to confirm: the suggestion first, then the alternatives. Asked only once. */
  confirm: { suggested: ReplyLanguage; alternatives: ReplyLanguage[] } | null;
}

/**
 * Chooses the reply language:
 * 1. an explicit choice always wins;
 * 2. a message whose language is clear decides;
 * 3. when the words fit several languages, the previous reply language is kept if it fits;
 *    otherwise the one matching the interface locale (or the first) is suggested and the customer
 *    is asked once;
 * 4. without words (emoji, numbers), the previous language, then the interface locale, then English.
 */
export function resolveReplyLanguage(input: LanguagePreferenceInput): LanguageResolution {
  if (input.explicit) return { language: input.explicit, source: 'explicit', confirm: null };
  const detection = input.detection;
  const candidates = detection?.candidates ?? [];
  if (detection?.language) {
    return { language: detection.language, source: 'detected', confirm: null };
  }
  if (input.decided && candidates.includes(input.decided)) {
    return { language: input.decided, source: 'decided', confirm: null };
  }
  if (candidates.length > 0) {
    // Keep the language already in use when it fits; otherwise suggest from the locale.
    const kept = input.previous && candidates.includes(input.previous) ? input.previous : undefined;
    const fromLocale = input.uiLocale ? localeMatch(input.uiLocale, candidates) : undefined;
    const suggested = kept ?? fromLocale ?? (candidates[0] as ReplyLanguage);
    const alternatives = candidates.filter((c) => c !== suggested);
    return {
      language: suggested,
      source: kept ? 'previous' : 'suggested',
      // The customer is asked until they choose or close the question, and then never again.
      confirm: input.prompted || alternatives.length === 0 ? null : { suggested, alternatives },
    };
  }
  if (input.previous) return { language: input.previous, source: 'previous', confirm: null };
  if (input.uiLocale) {
    return { language: LANGUAGE_OF_LOCALE[input.uiLocale], source: 'locale', confirm: null };
  }
  return { language: 'en', source: 'default', confirm: null };
}

/** The candidate a locale points to: Hindi → Hinglish, Urdu → Roman Urdu in Latin script. */
function localeMatch(
  locale: UiLocale,
  candidates: readonly ReplyLanguage[],
): ReplyLanguage | undefined {
  const same = LANGUAGE_OF_LOCALE[locale];
  if (candidates.includes(same)) return same;
  const latin = locale === 'hi' ? 'hi-Latn' : locale === 'ur' ? 'ur-Latn' : undefined;
  return latin && candidates.includes(latin) ? latin : undefined;
}

// ---------------------------------------------------------------------------------------------
// Communication style (U10): wording only; facts and entitlements never change with it.

export const STYLE_VERBOSITY = ['concise', 'conversational', 'formal'] as const;
export type StyleVerbosity = (typeof STYLE_VERBOSITY)[number];
export const STYLE_TONES = ['gentle', 'direct'] as const;
export type StyleTone = (typeof STYLE_TONES)[number];

export interface CommunicationStyle {
  verbosity?: StyleVerbosity | null;
  tone?: StyleTone | null;
}

const VERBOSITY_RULES: Record<StyleVerbosity, string> = {
  concise: 'Use as few words as possible.',
  conversational: 'Write in a relaxed, conversational way.',
  formal: 'Write formally and politely.',
};
const TONE_RULES: Record<StyleTone, string> = {
  gentle: 'Phrase things gently.',
  direct: 'Be direct and get to the point.',
};

/** The style a customer asked for, as prompt lines. It changes wording, never facts or eligibility. */
export function styleInstructions(style: CommunicationStyle): string[] {
  const lines: string[] = [];
  if (style.verbosity) lines.push(VERBOSITY_RULES[style.verbosity]);
  if (style.tone) lines.push(TONE_RULES[style.tone]);
  if (lines.length === 0) return [];
  return [
    ...lines,
    'The style changes only the wording. Facts, prices, policies and what the customer is entitled to stay exactly the same.',
  ];
}

// ---------------------------------------------------------------------------------------------
// Direction and bidirectional isolation (U04, U08)

export type TextDirection = 'rtl' | 'ltr';

/**
 * The direction a message reads in: right to left when most of its letters are Arabic-script (or
 * Hebrew), otherwise left to right. Identifiers are ignored, so a Urdu sentence that starts with an
 * order number still reads right to left. Null when the text has no letters (inherit).
 */
export function textDirection(text: string): TextDirection | null {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | null = null;
  for (const token of tokensOf(text)) {
    for (const char of token) {
      if (!LETTER.test(char)) continue;
      const direction: TextDirection =
        ARABIC_LETTER.test(char) || HEBREW_LETTER.test(char) ? 'rtl' : 'ltr';
      first ??= direction;
      if (direction === 'rtl') rtl += 1;
      else ltr += 1;
    }
  }
  if (rtl === ltr) return first;
  return rtl > ltr ? 'rtl' : 'ltr';
}

export interface BidiSegment {
  text: string;
  /** Show isolated and left to right: an identifier, email, web address, number or amount. */
  isolate: boolean;
}

const ISOLATE_TOKEN = new RegExp(
  [
    '[a-z][a-z0-9+.-]*://\\S+',
    'www\\.\\S+',
    '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
    // Amounts with a currency: AED 120, Rs. 1,500, $10, 120 PKR.
    '(?:[A-Z]{3}|Rs\\.?|[$€£₹﷼])\\s?\\p{N}[\\p{N},.]*',
    '\\p{N}[\\p{N},.]*\\s?[A-Z]{3}(?![\\p{L}])',
    // Anything with a digit: order and phone numbers, dates, times, codes.
    '[#+]?[\\p{L}\\p{N}_/-]*\\p{N}[\\p{L}\\p{N}_/.,:-]*',
    '[A-Z]{2,}[-_][A-Z0-9_-]+',
  ]
    .map((alternative) => `(?<![\\p{L}\\p{N}])(?:${alternative})`)
    .join('|'),
  'gu',
);

/**
 * Splits text so identifiers, amounts, emails and web addresses can be isolated left to right
 * (`<bdi dir="ltr">`) inside right-to-left sentences. Joining the segments gives back the text
 * exactly, so copying is unchanged.
 */
export function bidiSegments(text: string): BidiSegment[] {
  const segments: BidiSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(ISOLATE_TOKEN)) {
    const start = match.index ?? 0;
    // Trailing sentence punctuation stays with the sentence.
    const token = match[0].replace(/[.,:]+$/u, '');
    if (token === '') continue;
    if (start > last) segments.push({ text: text.slice(last, start), isolate: false });
    segments.push({ text: token, isolate: true });
    last = start + token.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), isolate: false });
  return segments;
}
