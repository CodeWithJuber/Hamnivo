import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { aiPowerEn } from './ai-power/en';
import { billingEn } from './billing/en';
import { en } from './en';
import { goLiveEn } from './go-live/en';
import { inboxAlertsEn } from './inbox-alerts/en';
import { migrationEn } from './migration/en';
import { paletteEn } from './palette/en';
import { platformCopy } from './platform';
import { setupEn } from './setup/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en & {
        migration: typeof migrationEn;
        billing: typeof billingEn;
        setup: typeof setupEn;
        inboxAlerts: typeof inboxAlertsEn;
        aiPower: typeof aiPowerEn;
        palette: typeof paletteEn;
        agentic: typeof platformCopy.en;
        goLive: typeof goLiveEn;
      };
    };
  }
}

export const LOCALES = ['en', 'ar', 'hi', 'ur'] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES = new Set<Locale>(['ar', 'ur']);
/** Each language named in itself, so people can find their own. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
  ur: 'اردو',
};

const STORAGE_KEY = 'hamnivo.studio.locale';

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

export const directionOf = (locale: Locale) => (RTL_LOCALES.has(locale) ? 'rtl' : 'ltr');

function stored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** ?lang= (for shared links), then the saved choice, then the browser's language. */
export function initialLocale(): Locale {
  const fromQuery = new URLSearchParams(window.location.search).get('lang');
  if (isLocale(fromQuery)) return fromQuery;
  const saved = stored();
  if (isLocale(saved)) return saved;
  const browser = navigator.language?.toLowerCase().split('-')[0];
  return isLocale(browser) ? browser : 'en';
}

/** Studio's words in English: the fallback, always in the first download. */
const english = {
  ...en,
  agentic: platformCopy.en,
  migration: migrationEn,
  billing: billingEn,
  setup: setupEn,
  inboxAlerts: inboxAlertsEn,
  aiPower: aiPowerEn,
  palette: paletteEn,
  goLive: goLiveEn,
};

/**
 * The other languages, each in its own file, load when first needed: a person downloads only the
 * language they read (85 to 95 kB gzipped each, built).
 */
const OTHERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: object }>> = {
  ar: () => import('./languages/ar'),
  hi: () => import('./languages/hi'),
  ur: () => import('./languages/ur'),
};

const wordsOf = async (locale: Locale): Promise<object> =>
  locale === 'en' ? english : (await OTHERS[locale]()).default;

/** Makes a language ready to show: loads its words the first time it is chosen. */
export async function ensureLocale(locale: Locale): Promise<void> {
  if (i18next.hasResourceBundle(locale, 'translation')) return;
  i18next.addResourceBundle(locale, 'translation', await wordsOf(locale));
}

export async function initI18n(locale: Locale) {
  const resources: Partial<Record<Locale, { translation: object }>> = {
    en: { translation: english },
  };
  if (locale !== 'en') resources[locale] = { translation: await wordsOf(locale) };
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return i18next;
}

/** Sets the document language and direction (right to left for Arabic and Urdu). */
export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice then lasts for this page only.
  }
}

export async function changeLocale(locale: Locale) {
  // The words come first, so the page never shows a half-translated screen.
  await ensureLocale(locale);
  applyLocale(locale);
  await i18next.changeLanguage(locale);
}
