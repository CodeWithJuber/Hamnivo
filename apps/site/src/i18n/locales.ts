import type { Locale } from '@hamnivo/brand';

export type { Locale };

interface LocaleInfo {
  /** Name in its own language, for the language switcher. */
  name: string;
  dir: 'ltr' | 'rtl';
  /** Open Graph locale (language_TERRITORY). */
  ogLocale: string;
}

export const localeInfo: Record<Locale, LocaleInfo> = {
  en: { name: 'English', dir: 'ltr', ogLocale: 'en_US' },
  ar: { name: 'العربية', dir: 'rtl', ogLocale: 'ar_AR' },
  hi: { name: 'हिन्दी', dir: 'ltr', ogLocale: 'hi_IN' },
  ur: { name: 'اردو', dir: 'rtl', ogLocale: 'ur_PK' },
};

export const locales = Object.keys(localeInfo) as Locale[];
export const defaultLocale: Locale = 'en';

/** English lives at the root; every other language under its own folder. */
export function localePath(locale: Locale): string {
  return locale === defaultLocale ? '/' : `/${locale}/`;
}
