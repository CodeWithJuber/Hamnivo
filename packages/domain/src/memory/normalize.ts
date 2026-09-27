import { normalizeForMatching } from '../human-request.js';

/**
 * Control characters, zero-width spaces, byte-order marks and bidirectional overrides (which can
 * make text display differently from what it says). Joiners that shape Urdu and Hindi stay.
 */
const INVISIBLE = /[\p{Cc}\u200b\u202a-\u202e\u2066-\u2069\u2060\ufeff]/gu;
const QUOTES = /^["'“”‘’«»「」]+|["'“”‘’«»「」]+$/g;

/** A value as it is stored: one line, trimmed, without control characters or wrapping quotes. */
export function cleanMemoryValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .trim()
    .replace(QUOTES, '')
    .trim();
}

/** The form two values are compared in: case, spelling variants and punctuation folded. */
export function comparableValue(value: string): string {
  return normalizeForMatching(cleanMemoryValue(value));
}

/** Whether two values say the same thing, for deduplication and "unchanged" decisions. */
export function sameMemoryValue(a: string, b: string): boolean {
  return comparableValue(a) === comparableValue(b);
}

/**
 * Whether a quoted piece of evidence really appears in a source text (the provenance check). Both
 * sides are normalized, so case, punctuation and spelling variants do not matter; a quote must
 * still be at least three characters long.
 */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const needle = normalizeForMatching(quote);
  if (needle.replace(/ /g, '').length < 3) return false;
  return ` ${normalizeForMatching(text)} `.includes(` ${needle} `);
}
