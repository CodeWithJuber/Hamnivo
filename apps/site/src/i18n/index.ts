import { ar } from './ar';
import { en } from './en';
import { hi } from './hi';
import type { Locale } from './locales';
import type { Dictionary } from './types';
import { ur } from './ur';

export const dictionaries: Record<Locale, Dictionary> = { en, ar, hi, ur };

export { defaultLocale, type Locale, localeInfo, localePath, locales } from './locales';
export type { Dictionary } from './types';
