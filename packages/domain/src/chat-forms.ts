/**
 * Rules for what the chat asks before it starts (W26, W27, W11), shared by the gateway, which
 * enforces them, and anything that previews them.
 */

/**
 * Countries whose visitors are asked for consent when a brand chooses "EU, EEA and UK": the 27
 * EU members, Iceland, Liechtenstein and Norway (the EEA), and the United Kingdom.
 */
export const CONSENT_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'GB',
]);

export type ConsentModeName = 'off' | 'everyone' | 'eu';

/**
 * Whether a visitor must agree before chatting. With "EU, EEA and UK", a connection whose country
 * is unknown is asked too: it is safer to ask once too often than to skip someone who must be
 * asked. The country comes from the request and is never stored.
 */
export function consentRequired(mode: ConsentModeName, country: string | null): boolean {
  if (mode === 'off') return false;
  if (mode === 'everyone') return true;
  return country === null || CONSENT_COUNTRIES.has(country.toUpperCase());
}

/** A plausible email address: something@domain.tld, no spaces, at most 254 characters. */
export function plausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** A plausible phone number: digits with optional +, spaces, dashes, dots and brackets. */
export function plausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return /^\+?[\d\s().-]{4,32}$/.test(value) && digits.length >= 4 && digits.length <= 20;
}
