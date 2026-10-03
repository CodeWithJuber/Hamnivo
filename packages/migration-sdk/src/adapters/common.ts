import type { Issue } from '../types.js';
import { PackageError, utf8 } from '../zip.js';

/** Helpers the file adapters share. None of them keeps or reports content. */

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-empty string, cut to `max` characters. */
export const text = (value: unknown, max = 255): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : undefined;

export const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** An ID given as an integer or a string, as a string. */
export function idOf(value: unknown, max = 200): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  return text(value, max)?.trim() || undefined;
}

export function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** Unix seconds (as Intercom gives times) or an ISO time. */
export function unixTime(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{9,11}$/.test(value)) return unixTime(Number(value));
  if (typeof value !== 'number') return isoTime(value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const time = new Date(value * 1000);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** Whether JSON that can't be parsed was cut short (the parser ran out of text) or is damaged. */
export function jsonError(error: unknown, content?: string): 'truncated_file' | 'invalid_json' {
  const message = error instanceof Error ? error.message : '';
  if (/end of (json )?(data|input)|unterminated|unexpected end/i.test(message)) {
    return 'truncated_file';
  }
  const position = /at position (\d+)/.exec(message)?.[1];
  return content !== undefined &&
    position !== undefined &&
    Number(position) >= content.trimEnd().length
    ? 'truncated_file'
    : 'invalid_json';
}

/** Operating-system clutter inside archives (for example macOS resource forks). */
export const isClutter = (name: string) => /(^|\/)(__MACOSX\/|\.DS_Store$)/.test(name);

export const isJsonFile = (name: string) => /\.(json|ndjson|jsonl)$/i.test(name);

/** One JSON value of an export file, with where it is. */
export interface JsonValue {
  value: unknown;
  /** Where in the export, for people: `file:line` for NDJSON, `file#/pointer` otherwise. */
  location: string;
  /** JSON Pointer to the value; NDJSON lines count as the items of an array (line 3 is `/2`). */
  pointer: string;
}

/**
 * Every JSON value of a file: one per line for NDJSON, the items of a document holding an array,
 * or the document itself. Unreadable lines are reported, never guessed at.
 */
export function jsonValues(
  file: string,
  bytes: Uint8Array,
  issues: Issue[],
): { values: JsonValue[]; truncated: boolean } {
  let content: string;
  try {
    content = utf8(bytes);
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    issues.push({ severity: 'error', code: 'invalid_json', location: file });
    return { values: [], truncated: false };
  }
  let whole: unknown;
  let wholeError: unknown = null;
  try {
    whole = JSON.parse(content);
  } catch (error) {
    wholeError = error;
  }
  if (wholeError === null) {
    if (Array.isArray(whole)) {
      return {
        values: whole.map((value, index) => ({
          value,
          location: `${file}#/${index}`,
          pointer: `/${index}`,
        })),
        truncated: false,
      };
    }
    return { values: [{ value: whole, location: file, pointer: '' }], truncated: false };
  }
  const lines = content.split('\n');
  // One object per line (NDJSON) when any of the first lines holds one: a damaged line then
  // doesn't hide the others. Otherwise the file is one document that can't be read.
  const ndjson = lines
    .filter((line) => line.trim() !== '')
    .slice(0, 5)
    .some((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === 'object' && value !== null;
      } catch {
        return false;
      }
    });
  if (!ndjson) {
    const code = jsonError(wholeError, content);
    issues.push({ severity: 'error', code, location: file });
    return { values: [], truncated: code === 'truncated_file' };
  }
  const complete = content.endsWith('\n');
  const values: JsonValue[] = [];
  let truncated = false;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const location = `${file}:${index + 1}`;
    try {
      values.push({ value: JSON.parse(line), location, pointer: `/${index}` });
    } catch (error) {
      if (index === lines.length - 1 && !complete && jsonError(error, line) === 'truncated_file') {
        truncated = true;
        issues.push({ severity: 'error', code: 'truncated_file', location });
      } else {
        issues.push({ severity: 'error', code: 'invalid_json', location });
      }
    }
  });
  return { values, truncated };
}

/** `location` of something inside a value (`file:3#/comments/0`, `file#/0/comments/0`). */
export const within = (location: string, pointer: string) =>
  pointer ? `${location}${location.includes('#') ? '' : '#'}${pointer}` : location;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
  times: '\u00d7',
  deg: '\u00b0',
  shy: '',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/**
 * Plain text from a message body in HTML: paragraphs and line breaks become new lines, links keep
 * their address, and every other tag is dropped (with scripts and styles, and their content).
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const linked = withoutCode.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, double: string | undefined, single: string | undefined, inner: string) => {
      // Entities are decoded once, at the end, for the whole text.
      const href = (double ?? single ?? '').trim();
      const label = inner.replace(/<[^>]*>/g, '').trim();
      if (!/^https?:\/\//i.test(href)) return label;
      return !label || decodeEntities(label) === decodeEntities(href) ? href : `${label} (${href})`;
    },
  );
  const lines = linked
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<\/(p|div|ul|ol|h[1-6]|blockquote|pre|tr|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(lines)
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
