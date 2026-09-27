/**
 * ISO 4217 currencies in current use and the number of digits in their minor unit. Amounts are
 * stored as integer counts of the minor unit, so this table decides what "1" means for each code.
 * Fund and unit-of-account codes (CLF, UYW…), precious-metal and testing codes (XAU, XDR, XTS…)
 * and withdrawn codes (HRK, SLL, ZWL…) are left out on purpose: a quote in one of them is refused
 * rather than guessed.
 */

const ZERO = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
] as const;

const THREE = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;

const TWO = [
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'AOA',
  'ARS',
  'AUD',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BGN',
  'BMD',
  'BND',
  'BOB',
  'BRL',
  'BSD',
  'BTN',
  'BWP',
  'BYN',
  'BZD',
  'CAD',
  'CDF',
  'CHF',
  'CNY',
  'COP',
  'CRC',
  'CUP',
  'CVE',
  'CZK',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'ERN',
  'ETB',
  'EUR',
  'FJD',
  'FKP',
  'GBP',
  'GEL',
  'GHS',
  'GIP',
  'GMD',
  'GTQ',
  'GYD',
  'HKD',
  'HNL',
  'HTG',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'IRR',
  'JMD',
  'KES',
  'KGS',
  'KHR',
  'KPW',
  'KYD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LRD',
  'LSL',
  'MAD',
  'MDL',
  'MGA',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MRU',
  'MUR',
  'MVR',
  'MWK',
  'MXN',
  'MYR',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NOK',
  'NPR',
  'NZD',
  'PAB',
  'PEN',
  'PGK',
  'PHP',
  'PKR',
  'PLN',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SBD',
  'SCR',
  'SDG',
  'SEK',
  'SGD',
  'SHP',
  'SLE',
  'SOS',
  'SRD',
  'SSP',
  'STN',
  'SVC',
  'SYP',
  'SZL',
  'THB',
  'TJS',
  'TMT',
  'TOP',
  'TRY',
  'TTD',
  'TWD',
  'TZS',
  'UAH',
  'USD',
  'UYU',
  'UZS',
  'VES',
  'WST',
  'XCD',
  'XCG',
  'YER',
  'ZAR',
  'ZMW',
  'ZWG',
] as const;

export type CurrencyCode = (typeof ZERO)[number] | (typeof TWO)[number] | (typeof THREE)[number];

const MINOR_DIGITS: ReadonlyMap<string, number> = new Map<string, number>([
  ...ZERO.map((code) => [code, 0] as const),
  ...TWO.map((code) => [code, 2] as const),
  ...THREE.map((code) => [code, 3] as const),
]);

export const CURRENCY_CODES: readonly CurrencyCode[] = [
  ...MINOR_DIGITS.keys(),
] as readonly CurrencyCode[];

export class UnknownCurrencyError extends Error {
  override name = 'UnknownCurrencyError';
  constructor(readonly code: string) {
    super(`Unknown or unsupported ISO 4217 currency: ${code}`);
  }
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && MINOR_DIGITS.has(value);
}

/** Digits in the minor unit (2 for AED: 1 AED = 100 fils). Throws for codes not in the table. */
export function minorDigits(code: string): number {
  const digits = MINOR_DIGITS.get(code);
  if (digits === undefined) throw new UnknownCurrencyError(code);
  return digits;
}

/** Normalizes a code the way people type it (" aed ") and checks it against the table. */
export function currencyOf(value: string): CurrencyCode {
  const code = value.trim().toUpperCase();
  if (!isCurrencyCode(code)) throw new UnknownCurrencyError(value);
  return code;
}
