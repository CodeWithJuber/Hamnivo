/**
 * What may be kept about a visitor's page views. Everything here is a plain function: the rules
 * for page addresses, the privacy signals a browser sends, and the few fields that are read from
 * headers. No IP address is read anywhere in the visitors module.
 */

type Headers = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Whether the browser asks not to be tracked: Do Not Track (`DNT: 1`) or Global Privacy Control
 * (`Sec-GPC: 1`). Either one leaves the visitor out, whatever the brand chose.
 */
export function privacyOptOut(headers: Headers): boolean {
  return first(headers.dnt)?.trim() === '1' || first(headers['sec-gpc'])?.trim() === '1';
}

/** Query parameters whose values are removed even when a brand keeps query strings. */
const SENSITIVE = /token|password|passwd|secret|key|auth|code|session|sid\b|signature|otp|jwt/i;

export interface CleanPage {
  /** The address as kept: origin and path, with the query string only when the brand keeps it. */
  url: string;
  origin: string;
}

/**
 * A page address as it may be stored: only http and https; no user name, password or fragment; no
 * query string unless the brand keeps them, and then without values that look like secrets.
 */
export function cleanUrl(raw: string, keepQuery: boolean): CleanPage | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  if (!keepQuery) parsed.search = '';
  else {
    for (const [name] of [...parsed.searchParams]) {
      if (SENSITIVE.test(name)) parsed.searchParams.set(name, '[removed]');
    }
  }
  const url = parsed.toString();
  return url.length > 1000 ? null : { url, origin: parsed.origin };
}

/** A referrer, without query string or fragment (it is another site's address). */
export function cleanReferrer(raw: string | undefined): string | null {
  if (!raw) return null;
  const page = cleanUrl(raw, false);
  return page ? page.url : null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** A page title on one line, without control characters, at most 200 characters. */
export function cleanTitle(raw: string | undefined): string | null {
  const flat = raw?.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 200) : null;
}

/**
 * The visitor's country from the `CF-IPCountry` header Cloudflare adds. `XX` (unknown) and `T1`
 * (Tor) say nothing about where a person is, so they count as no country.
 */
export function countryOf(headers: Headers): string | null {
  const value = first(headers['cf-ipcountry'])?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1' ? value : null;
}

/** A language tag from the browser, or null when it is not one. */
export function cleanLanguage(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(value) ? value : null;
}
