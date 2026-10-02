/**
 * Digits in Arabic-Indic (٠-٩), Extended Arabic-Indic as used in Urdu (۰-۹) and Devanagari (०-९)
 * become ASCII, and thousands separators between digits are dropped, so "١٢٠", "۱۲۰", "१२०"
 * and "120" compare equal, and so do "5,000" and "5000".
 */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0966 && code <= 0x096f) out += String(code - 0x0966);
    else out += char;
  }
  return out.replace(/(\d)[,٬'](?=\d{3}(?!\d))/g, '$1');
}

/** Whether `text` states the number `value` as a whole number (10 is not found in 100 or 1.10). */
export function statesValue(text: string, value: string): boolean {
  const normalized = normalizeDigits(text);
  const escaped = normalizeDigits(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(normalized);
}

/** Every number written in `text`, in order, in ASCII digits. */
export function numbersIn(text: string): string[] {
  return normalizeDigits(text).match(/\d+(?:\.\d+)?/g) ?? [];
}
