import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar } from './ar';
import { en } from './en';
import { hi } from './hi';
import { inboxAlertsAr } from './inbox-alerts/ar';
import { inboxAlertsEn } from './inbox-alerts/en';
import { inboxAlertsHi } from './inbox-alerts/hi';
import { inboxAlertsUr } from './inbox-alerts/ur';
import { migrationAr } from './migration/ar';
import { migrationEn } from './migration/en';
import { migrationHi } from './migration/hi';
import { migrationUr } from './migration/ur';
import { ur } from './ur';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en & { migration: typeof migrationEn; inboxAlerts: typeof inboxAlertsEn };
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

export async function initI18n(locale: Locale) {
  await i18next.use(initReactI18next).init({
    resources: {
      en: { translation: { ...en, migration: migrationEn, inboxAlerts: inboxAlertsEn } },
      ar: { translation: { ...ar, migration: migrationAr, inboxAlerts: inboxAlertsAr } },
      hi: { translation: { ...hi, migration: migrationHi, inboxAlerts: inboxAlertsHi } },
      ur: { translation: { ...ur, migration: migrationUr, inboxAlerts: inboxAlertsUr } },
    },
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
  applyLocale(locale);
  await i18next.changeLanguage(locale);
}
