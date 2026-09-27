import { minorDigits } from './currencies.js';
import { type Money, toMajorString } from './money.js';

/**
 * Locale-safe display of amounts and times (U06). Arithmetic never happens here: the exact
 * decimal string of a Money value goes to Intl.NumberFormat, which formats strings without
 * rounding through a float. Every time carries its time zone, so "1:00" is never ambiguous.
 */

/**
 * Which digits to use. `auto` follows the locale's own default (CLDR): Latin digits for `ar`,
 * Arabic-Indic for `ar-SA` and `ar-EG`, Eastern Arabic-Indic for `ur-IN`. `native` asks for the
 * script's digits where the language has them (Arabic-Indic, Eastern Arabic-Indic for Urdu and
 * Persian, Devanagari for Hindi). `latin` is always 0–9.
 */
export type DigitPreference = 'auto' | 'native' | 'latin';

const NATIVE_DIGITS: Record<string, string> = {
  ar: 'arab',
  ur: 'arabext',
  fa: 'arabext',
  hi: 'deva',
  mr: 'deva',
  ne: 'deva',
  bn: 'beng',
};

/** The BCP 47 tag to hand to Intl, with a `-u-nu-` numbering system when one is requested. */
export function localeTag(locale: string, digits: DigitPreference = 'auto'): string {
  const base = locale.split('-u-')[0] || 'en';
  if (digits === 'auto') return base;
  const language = base.split('-')[0]?.toLowerCase() ?? 'en';
  const system = digits === 'latin' ? 'latn' : NATIVE_DIGITS[language];
  return system ? `${base}-u-nu-${system}` : base;
}

export interface MoneyFormatOptions {
  digits?: DigitPreference;
  /** `symbol` (AED, د.إ.‏, ₹…) as the locale writes it, or always the ISO `code`. */
  display?: 'symbol' | 'code' | 'narrowSymbol';
}

/** "AED 60.00", "‏60.00 د.إ.‏", "₹१२,३४,५६७.५०" — exactly the minor units stored. */
export function formatMoney(m: Money, locale: string, options: MoneyFormatOptions = {}): string {
  const digits = minorDigits(m.currency);
  const format = new Intl.NumberFormat(localeTag(locale, options.digits), {
    style: 'currency',
    currency: m.currency,
    currencyDisplay: options.display ?? 'symbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return format.format(toMajorString(m) as `${number}`);
}

/** A count ("2", "٢", "२") in the locale's digits. */
export function formatQuantity(
  value: number | bigint,
  locale: string,
  digits: DigitPreference = 'auto',
): string {
  return new Intl.NumberFormat(localeTag(locale, digits), { maximumFractionDigits: 0 }).format(
    value,
  );
}

export interface DateTimeFormatOptions {
  digits?: DigitPreference;
  /** IANA zone the reader is in (e.g. Asia/Dubai). The zone is always printed with the time. */
  timeZone: string;
  /** Date and time (default) or only the time of day. */
  part?: 'datetime' | 'time';
}

/** "Sep 28, 2026, 1:00 AM GMT+4": the zone is part of the text, never implied. */
export function formatDateTime(
  value: Date,
  locale: string,
  options: DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(localeTag(locale, options.digits), {
    ...(options.part === 'time' ? {} : { year: 'numeric', month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone,
    timeZoneName: 'short',
  }).format(value);
}
