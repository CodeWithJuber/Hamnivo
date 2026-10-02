/**
 * Deterministic personal-data spotting for minimization: what goes to a decision provider and what
 * may be cached (K01, K06). It errs towards finding too much. Finding nothing is not proof that a
 * text is anonymous; callers still decide by data class and audience.
 */

export const PERSONAL_DATA_KINDS = [
  'email',
  'phone',
  'payment_card',
  'iban',
  'reference',
  'address',
] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

const EMAIL = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}/gu;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gu;
/** Digit runs that may hold separators: phone and card numbers. */
const DIGIT_RUN = /[+(]?\p{N}[\p{N} ().-]{5,}\p{N}/gu;
/**
 * Order, ticket, account and tracking references: a word with letters and digits, or #1234. Plain
 * years and small numbers are not references.
 */
const REFERENCE =
  /(?<![\p{L}\p{N}])(?:#\p{N}{3,}|[\p{L}]{1,6}[-_]?\p{N}{3,}[\p{L}\p{N}-]*|\p{N}{3,}[-_][\p{L}\p{N}-]+)(?![\p{L}\p{N}])/gu;
/** Street addresses need a number next to a street word (English, Urdu, Hindi and Arabic). */
const ADDRESS =
  /\p{N}+[\p{L}\p{N}/-]*\s+(?:[\p{L}'-]+\s+){0,3}(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|block|sector|phase|house|flat|apartment|apt\.?|gali|mohalla|sarak|سڑک|گلی|محلہ|मोहल्ला|गली|شارع|حي)(?![\p{L}])/giu;

/** Dates are not phone numbers or references: 2026-09-27, 27/09/2026, 27.9.26. */
const DATE = /^(?:\p{N}{4}-\p{N}{1,2}-\p{N}{1,2}|\p{N}{1,2}[./-]\p{N}{1,2}[./-]\p{N}{2,4})$/u;

/** Arabic-Indic, Extended Arabic-Indic (Urdu) and Devanagari digits. */
const NATIVE_DIGIT = /[٠-٩۰-۹०-९]/gu;

function asciiDigits(text: string): string {
  return text.replace(NATIVE_DIGIT, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const zero = code >= 0x0966 ? 0x0966 : code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - zero);
  });
}

/** Luhn checksum, so a 16-digit card number is told apart from other long numbers. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

interface Found {
  kind: PersonalDataKind;
  start: number;
  end: number;
}

function scan(text: string): Found[] {
  const normalized = asciiDigits(text);
  const found: Found[] = [];
  const add = (kind: PersonalDataKind, match: RegExpMatchArray) => {
    const start = match.index ?? 0;
    found.push({ kind, start, end: start + match[0].length });
  };
  for (const match of normalized.matchAll(EMAIL)) add('email', match);
  for (const match of normalized.matchAll(IBAN)) add('iban', match);
  for (const match of normalized.matchAll(DIGIT_RUN)) {
    if (DATE.test(match[0].trim())) continue;
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) add('payment_card', match);
    else if (digits.length >= 7 && digits.length <= 15) add('phone', match);
  }
  for (const match of normalized.matchAll(REFERENCE)) {
    if (!DATE.test(match[0])) add('reference', match);
  }
  for (const match of normalized.matchAll(ADDRESS)) add('address', match);
  // Overlaps keep the earliest, then the longest match (an email contains a reference-like part).
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Found[] = [];
  for (const item of found) {
    const last = kept.at(-1);
    if (last && item.start < last.end) continue;
    kept.push(item);
  }
  return kept;
}

/** The kinds of personal data a text appears to contain, without the values. */
export function findPersonalData(text: string): PersonalDataKind[] {
  return [...new Set(scan(text).map((f) => f.kind))];
}

/**
 * Replaces personal data with typed placeholders (`[email]`, `[phone]`, `[reference]`, …) so a
 * decision provider can still see that an order number was given without seeing it.
 */
export function redactPersonalData(text: string): string {
  const found = scan(text);
  let out = '';
  let last = 0;
  for (const item of found) {
    out += `${text.slice(last, item.start)}[${item.kind}]`;
    last = item.end;
  }
  return out + text.slice(last);
}
