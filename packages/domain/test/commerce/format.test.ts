import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatMoney,
  formatQuantity,
  localeTag,
  money,
  parseAmountInput,
} from '../../src/commerce/index.js';

/** Intl uses no-break spaces and bidi marks; compare with plain spaces and without the marks. */
const plain = (text: string) => text.replace(/\s/g, ' ').replace(/[‎‏؜]/g, '');

describe('formatMoney (U06)', () => {
  it('prints exactly the stored minor units in the locale', () => {
    expect(plain(formatMoney(money(6000, 'AED'), 'en'))).toBe('AED 60.00');
    expect(plain(formatMoney(money(-1500, 'AED'), 'en'))).toBe('-AED 15.00');
    expect(plain(formatMoney(money(1500, 'JPY'), 'en'))).toBe('¥1,500');
    expect(plain(formatMoney(money(1500, 'KWD'), 'en'))).toBe('KWD 1.500');
    // ISO 4217 digits even where display data would drop them.
    expect(plain(formatMoney(money(123_456, 'HUF'), 'en'))).toBe('HUF 1,234.56');
    expect(plain(formatMoney(money('12345678901234567899', 'AED'), 'en'))).toBe(
      'AED 123,456,789,012,345,678.99',
    );
    expect(plain(formatMoney(money(6000, 'AED'), 'en', { display: 'code' }))).toBe('AED 60.00');
  });

  it('uses Arabic, Hindi and Urdu digits where asked or where the locale defaults to them', () => {
    expect(plain(formatMoney(money(6000, 'AED'), 'ar', { digits: 'native' }))).toBe('٦٠٫٠٠ د.إ.');
    expect(plain(formatMoney(money(6000, 'AED'), 'ar-SA'))).toBe('٦٠٫٠٠ د.إ.');
    expect(plain(formatMoney(money(6000, 'AED'), 'ar', { digits: 'latin' }))).toBe('60.00 د.إ.');
    expect(plain(formatMoney(money(123_456_750, 'INR'), 'hi'))).toBe('₹12,34,567.50');
    expect(plain(formatMoney(money(123_456_750, 'INR'), 'hi', { digits: 'native' }))).toBe(
      '₹१२,३४,५६७.५०',
    );
    expect(plain(formatMoney(money(150_050, 'PKR'), 'ur', { digits: 'native' }))).toBe(
      'Rs ۱٬۵۰۰٫۵۰',
    );
    expect(plain(formatMoney(money(6000, 'PKR'), 'ur'))).toBe('Rs 60.00');
  });

  it('builds locale tags with a numbering system only when one is requested', () => {
    expect(localeTag('ar')).toBe('ar');
    expect(localeTag('ar', 'native')).toBe('ar-u-nu-arab');
    expect(localeTag('ur-PK', 'native')).toBe('ur-PK-u-nu-arabext');
    expect(localeTag('hi', 'native')).toBe('hi-u-nu-deva');
    expect(localeTag('en', 'native')).toBe('en');
    expect(localeTag('ar-SA', 'latin')).toBe('ar-SA-u-nu-latn');
    expect(localeTag('ar-u-nu-arab', 'latin')).toBe('ar-u-nu-latn');
    expect(formatQuantity(2, 'ar', 'native')).toBe('٢');
    expect(formatQuantity(12, 'hi', 'native')).toBe('१२');
  });
});

describe('formatDateTime (U06)', () => {
  const at = new Date('2026-09-27T21:00:00Z');

  it('always names the time zone, so an expiry time is never ambiguous', () => {
    expect(plain(formatDateTime(at, 'en', { timeZone: 'Asia/Dubai' }))).toBe(
      'Sep 28, 2026, 1:00 AM GMT+4',
    );
    expect(plain(formatDateTime(at, 'en', { timeZone: 'UTC' }))).toBe('Sep 27, 2026, 9:00 PM UTC');
    expect(plain(formatDateTime(at, 'en', { timeZone: 'Asia/Karachi', part: 'time' }))).toBe(
      '2:00 AM GMT+5',
    );
    expect(plain(formatDateTime(at, 'ar', { timeZone: 'Asia/Dubai', digits: 'native' }))).toBe(
      '٢٨ سبتمبر ٢٠٢٦، ١:٠٠ ص غرينتش+٤',
    );
  });

  it('shows a calendar date alone, as stored when read in UTC', () => {
    const estimate = new Date('2026-10-05T00:00:00Z');
    expect(plain(formatDateTime(estimate, 'en', { timeZone: 'UTC', part: 'date' }))).toBe(
      'Oct 5, 2026',
    );
    expect(
      plain(formatDateTime(estimate, 'hi', { timeZone: 'UTC', part: 'date', digits: 'native' })),
    ).toBe('५ अक्टू॰ २०२६');
  });
});

describe('parseAmountInput (U06)', () => {
  const exact = (input: string, currency = 'AED') => {
    const result = parseAmountInput(input, currency);
    if (result.kind !== 'exact') throw new Error(`${input}: ${JSON.stringify(result)}`);
    return result.money.amountMinor;
  };
  const readings = (input: string, currency = 'AED') => {
    const result = parseAmountInput(input, currency);
    if (result.kind !== 'ambiguous') throw new Error(`${input}: ${JSON.stringify(result)}`);
    return result.candidates.map((m) => m.amountMinor);
  };

  it('reads plain and fully written amounts exactly', () => {
    expect(exact('1500')).toBe(150_000n);
    expect(exact('15')).toBe(1500n);
    expect(exact('15.5')).toBe(1550n);
    expect(exact('15.50')).toBe(1550n);
    expect(exact('0.500')).toBe(50n);
    expect(exact('1,500.00')).toBe(150_000n);
    expect(exact('1,500,000')).toBe(150_000_000n);
    expect(exact('1.500,00')).toBe(150_000n);
    expect(exact('12,34,567.50')).toBe(123_456_750n);
    expect(exact('AED 60')).toBe(6000n);
    expect(exact('60 aed')).toBe(6000n);
    expect(exact(' 1 500.25 ')).toBe(150_025n);
  });

  it('reads Arabic-Indic, Eastern Arabic-Indic and Devanagari digits and separators', () => {
    expect(exact('١٥٠٠')).toBe(150_000n);
    expect(exact('٦٠٫٥٠')).toBe(6050n);
    expect(exact('۱٬۵۰۰٫۵۰', 'PKR')).toBe(150_050n);
    expect(exact('१५००', 'INR')).toBe(150_000n);
    expect(exact('१२,३४,५६७.५०', 'INR')).toBe(123_456_750n);
  });

  it('asks when the same text means different amounts in different conventions', () => {
    // "1,500": fifteen hundred, or one and a half.
    expect(readings('1,500')).toEqual([150_000n, 150n]);
    expect(readings('1.500')).toEqual([150_000n, 150n]);
    expect(readings('١٬٥٠٠')).toEqual([150_000n, 150n]);
    // Three decimals do not exist in AED or yen, so only one reading is left to confirm.
    expect(readings('1.555')).toEqual([155_500n]);
    expect(readings('15.005')).toEqual([1_500_500n]);
    expect(readings('1.500', 'JPY')).toEqual([1500n]);
    expect(readings('1.555', 'KWD')).toEqual([1_555_000n, 1555n]);
  });

  it('explains what is wrong with other input', () => {
    expect(parseAmountInput('', 'AED')).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(parseAmountInput('-5', 'AED')).toEqual({ kind: 'invalid', reason: 'negative' });
    expect(parseAmountInput('fifteen', 'AED')).toEqual({ kind: 'invalid', reason: 'format' });
    expect(parseAmountInput('1,50', 'AED')).toEqual({ kind: 'invalid', reason: 'format' });
    expect(parseAmountInput('1,5000', 'AED')).toEqual({ kind: 'invalid', reason: 'format' });
    expect(parseAmountInput('15.0055', 'AED')).toEqual({ kind: 'invalid', reason: 'precision' });
    expect(parseAmountInput('1.5', 'JPY')).toEqual({ kind: 'invalid', reason: 'precision' });
    expect(parseAmountInput('1234567890123456', 'AED')).toEqual({
      kind: 'invalid',
      reason: 'too_large',
    });
    expect(parseAmountInput('USD 15', 'AED')).toEqual({ kind: 'invalid', reason: 'format' });
  });
});
