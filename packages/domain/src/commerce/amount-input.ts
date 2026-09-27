import { currencyOf, minorDigits } from './currencies.js';
import { fromMajor, InvalidAmountError, type Money } from './money.js';

/**
 * Reads an amount a person typed (U06). Digits in Arabic-Indic, Eastern Arabic-Indic and
 * Devanagari script are accepted, as are Arabic separators. When the same text means different
 * amounts under common conventions ("1,500" is 1500 in English and 1.5 in much of Europe), the
 * result is `ambiguous` with the readings, so the interface asks instead of guessing.
 */
export type AmountInput =
  | { kind: 'exact'; money: Money }
  | { kind: 'ambiguous'; candidates: Money[] }
  | { kind: 'invalid'; reason: 'empty' | 'format' | 'precision' | 'negative' | 'too_large' };

const DIGIT_BLOCKS: [number, number][] = [
  [0x0660, 0x0669], // Arabic-Indic
  [0x06f0, 0x06f9], // Eastern Arabic-Indic (Urdu, Persian)
  [0x0966, 0x096f], // Devanagari
];

function asciiDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const block = DIGIT_BLOCKS.find(([from, to]) => code >= from && code <= to);
    out += block ? String(code - block[0]) : char;
  }
  return out;
}

/** Group separators in the integer part must be every 3 digits, or Indian 2-2-3 (12,34,567). */
function validGrouping(integer: string, separator: string): boolean {
  const groups = integer.split(separator);
  const [first, ...rest] = groups;
  if (!first || first.length > 3 || !/^[0-9]+$/.test(first) || first.startsWith('0')) return false;
  if (rest.every((g) => /^[0-9]{3}$/.test(g))) return true;
  // Indian grouping: last group of 3, the ones before it of 2.
  const last = rest.at(-1);
  const middle = rest.slice(0, -1);
  return (
    first.length <= 2 &&
    last !== undefined &&
    /^[0-9]{3}$/.test(last) &&
    middle.length > 0 &&
    middle.every((g) => /^[0-9]{2}$/.test(g))
  );
}

const MAX_MAJOR_DIGITS = 15;

/** Drops trailing zeros beyond the currency's digits ("1.500" AED is 1.50); keeps others. */
function trimFraction(fraction: string, currency: string): string {
  const digits = minorDigits(currency);
  return fraction.length > digits && /^0*$/.test(fraction.slice(digits))
    ? fraction.slice(0, digits)
    : fraction;
}

function candidate(integer: string, rawFraction: string, currency: string): Money | null {
  const fraction = trimFraction(rawFraction, currency);
  if (integer.replace(/^0+/, '').length > MAX_MAJOR_DIGITS) return null;
  if (fraction.length > minorDigits(currency)) return null;
  try {
    return fromMajor(fraction ? `${integer}.${fraction}` : integer, currency);
  } catch (error) {
    if (error instanceof InvalidAmountError) return null;
    throw error;
  }
}

export function parseAmountInput(input: string, currency: string): AmountInput {
  const code = currencyOf(currency);
  let text = asciiDigits(input.normalize('NFKC'))
    .replaceAll('٫', '.')
    .replaceAll('٬', ',')
    .replace(/[\s   '’]/g, '');
  // A code or symbol typed with the amount is allowed; any other letters are not.
  text = text.replace(new RegExp(`^${code}|${code}$`, 'i'), '');
  text = text.replace(/^[$€£₹¥]|[$€£₹¥]$/g, '');
  if (text === '') return { kind: 'invalid', reason: 'empty' };
  if (text.startsWith('-')) return { kind: 'invalid', reason: 'negative' };
  if (!/^[0-9.,]+$/.test(text) || !/[0-9]/.test(text)) return { kind: 'invalid', reason: 'format' };

  const dots = [...text].filter((c) => c === '.').length;
  const commas = [...text].filter((c) => c === ',').length;
  const tooLarge = (digits: string) => digits.replace(/^0+/, '').length > MAX_MAJOR_DIGITS;

  const exact = (integer: string, rawFraction: string, separator: string | null): AmountInput => {
    if (separator && !validGrouping(integer, separator))
      return { kind: 'invalid', reason: 'format' };
    const plain = separator ? integer.replaceAll(separator, '') : integer;
    if (tooLarge(plain)) return { kind: 'invalid', reason: 'too_large' };
    const fraction = trimFraction(rawFraction, code);
    if (fraction.length > minorDigits(code)) return { kind: 'invalid', reason: 'precision' };
    const money = candidate(plain, fraction, code);
    return money ? { kind: 'exact', money } : { kind: 'invalid', reason: 'format' };
  };

  if (dots === 0 && commas === 0) return exact(text, '', null);

  if (dots > 0 && commas > 0) {
    // The separator that comes last, once, is the decimal point; the other groups thousands.
    const lastDot = text.lastIndexOf('.');
    const lastComma = text.lastIndexOf(',');
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const [integer = '', fraction = '', extra] = text.split(decimal);
    if (extra !== undefined || fraction.includes(group) || fraction === '') {
      return { kind: 'invalid', reason: 'format' };
    }
    return exact(integer, fraction, group);
  }

  const separator = dots > 0 ? '.' : ',';
  const count = Math.max(dots, commas);
  const [integer = '', fraction = ''] = text.split(separator);
  if (count > 1) return exact(text, '', separator);
  if (integer === '' || fraction === '') return { kind: 'invalid', reason: 'format' };
  if (fraction.length === 3 && !/^0+$/.test(integer)) {
    // "1,500" or "1.500": thousands, or a decimal fraction, depending on the writer's habits.
    const readings = [
      candidate(`${integer}${fraction}`, '', code),
      candidate(integer, fraction, code),
    ]
      .filter((m): m is Money => m !== null)
      .filter((m, i, all) => all.findIndex((o) => o.amountMinor === m.amountMinor) === i);
    if (readings.length === 0) return { kind: 'invalid', reason: 'format' };
    return { kind: 'ambiguous', candidates: readings };
  }
  // In English, Arabic, Hindi and Urdu a comma only groups thousands (three digits).
  if (separator === ',') return { kind: 'invalid', reason: 'format' };
  return exact(integer, fraction, null);
}
