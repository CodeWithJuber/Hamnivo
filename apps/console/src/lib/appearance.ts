/**
 * The look-and-wording editor's working copy of a brand's appearance, and what is wrong with it
 * before it is sent. The gateway checks all of it again (and is the one that decides); checking
 * here only says early, in plain words, what it would refuse.
 */
import type { LocalizedText } from '@hamnivo/contracts';
import { checkColour, isHexColour, type WidgetAppearance } from './setup';
import type { ChatLanguage } from './setup-data';

export type ChatTexts = Record<ChatLanguage, string>;

export const CHAT_LANGUAGES: readonly ChatLanguage[] = ['en', 'ar', 'hi', 'ur'];

/** One text per language, empty where there is none. */
export const textsOf = (
  value: Partial<Record<ChatLanguage, string>> | null | undefined,
): ChatTexts => ({
  en: value?.en ?? '',
  ar: value?.ar ?? '',
  hi: value?.hi ?? '',
  ur: value?.ur ?? '',
});

/** The languages written, or null when nothing is: Hamnivo's own words are then used. */
export function localizedOf(texts: ChatTexts): LocalizedText | null {
  const filled = CHAT_LANGUAGES.filter((lang) => texts[lang].trim());
  if (filled.length === 0) return null;
  const out: Partial<Record<ChatLanguage, string>> = {};
  for (const lang of filled) out[lang] = texts[lang].trim();
  // English is required by the gateway; `problemsOf` has already said so when it is missing.
  return { en: '', ...out };
}

export interface AppearanceDraft {
  /** `#RRGGBB`, as typed. */
  colour: string;
  logoUrl: string;
  radius: number;
  greeting: ChatTexts;
  offline: ChatTexts;
  csat: boolean;
  privacyUrl: string;
}

export const draftOf = (appearance: WidgetAppearance): AppearanceDraft => ({
  colour: appearance.primaryColor.toUpperCase(),
  logoUrl: appearance.logoUrl ?? '',
  radius: appearance.radius,
  greeting: textsOf(appearance.greeting),
  offline: textsOf(appearance.offlineText),
  csat: appearance.csat,
  privacyUrl: appearance.privacyUrl ?? '',
});

/** What is saved for a draft. */
export const bodyOf = (draft: AppearanceDraft): WidgetAppearance => ({
  primaryColor: draft.colour.trim().toUpperCase(),
  logoUrl: draft.logoUrl.trim() || null,
  radius: draft.radius,
  greeting: localizedOf(draft.greeting),
  offlineText: localizedOf(draft.offline),
  csat: draft.csat,
  privacyUrl: draft.privacyUrl.trim() || null,
});

export const isDirty = (draft: AppearanceDraft, saved: AppearanceDraft): boolean =>
  JSON.stringify(draft) !== JSON.stringify(saved);

/** A web address the chat may load: https, no user name or password, a sensible length. */
export function isHttpsUrl(value: string): boolean {
  const text = value.trim();
  if (text.length > 500) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type AppearanceProblem = 'colourFormat' | 'colourText' | 'colourFaint' | 'url' | 'english';

export interface AppearanceProblems {
  colour?: AppearanceProblem;
  logoUrl?: AppearanceProblem;
  privacyUrl?: AppearanceProblem;
  greeting?: AppearanceProblem;
  offline?: AppearanceProblem;
}

/** What would be refused, field by field; nothing is listed for a field that is fine. */
export function problemsOf(draft: AppearanceDraft): AppearanceProblems {
  const out: AppearanceProblems = {};
  if (!isHexColour(draft.colour)) out.colour = 'colourFormat';
  else {
    const check = checkColour(draft.colour);
    if (check?.problem === 'text') out.colour = 'colourText';
    if (check?.problem === 'faint') out.colour = 'colourFaint';
  }
  if (draft.logoUrl.trim() && !isHttpsUrl(draft.logoUrl)) out.logoUrl = 'url';
  if (draft.privacyUrl.trim() && !isHttpsUrl(draft.privacyUrl)) out.privacyUrl = 'url';
  // Other languages fall back to English, so there has to be an English text to fall back to.
  const needsEnglish = (texts: ChatTexts) =>
    !texts.en.trim() && CHAT_LANGUAGES.some((lang) => texts[lang].trim());
  if (needsEnglish(draft.greeting)) out.greeting = 'english';
  if (needsEnglish(draft.offline)) out.offline = 'english';
  return out;
}

/** The main colour to draw with: the one typed when it is a colour, else the chat's own. */
export const drawnColour = (draft: AppearanceDraft, fallback: string): string =>
  isHexColour(draft.colour) ? draft.colour.trim().toUpperCase() : fallback;
