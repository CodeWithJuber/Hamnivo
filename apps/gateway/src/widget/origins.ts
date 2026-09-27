/** Local development pages, which may use a widget whose brand allows no websites yet. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** CSP form of the local origins (CSP host sources cannot name IPv6 addresses). */
export const LOCAL_ANCESTORS = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
];

/**
 * Whether a page on `hostOrigin` may use a brand's widget. With no allowed websites only local
 * development pages may, and a page whose origin is unknown only then.
 */
export function originAllowed(allowed: readonly string[], hostOrigin: string | undefined): boolean {
  if (allowed.length === 0) return hostOrigin === undefined || LOCAL_ORIGIN.test(hostOrigin);
  if (hostOrigin === undefined) return false;
  try {
    return allowed.includes(new URL(hostOrigin).origin);
  } catch {
    return false;
  }
}

/** Sessions store "unknown" when the page did not say where it was. */
export const sessionOrigin = (stored: string): string | undefined =>
  stored === 'unknown' ? undefined : stored;
