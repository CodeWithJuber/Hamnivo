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
 * Whether a page is Studio itself (`studioOrigin` is where Studio runs). The owner opens a test
 * chat there to try their own widget: that page is never one of a brand's websites, so a session
 * from it is a test session, and only a test session may come from it.
 */
export function isStudioOrigin(studioOrigin: string, hostOrigin: string | undefined): boolean {
  if (hostOrigin === undefined) return false;
  try {
    return new URL(hostOrigin).origin === new URL(studioOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Whether a page on `hostOrigin` may use a brand's widget. With no allowed websites only local
 * development pages may, and a page whose origin is unknown only then. `testOrigin` is Studio's
 * origin, passed only for a test chat or for a session that already began as one: then Studio's
 * own page may use the widget too.
 */
export function originAllowed(
  allowed: readonly string[],
  hostOrigin: string | undefined,
  testOrigin?: string,
): boolean {
  if (testOrigin !== undefined && isStudioOrigin(testOrigin, hostOrigin)) return true;
  if (allowed.length === 0) return hostOrigin === undefined || LOCAL_ORIGIN.test(hostOrigin);
  if (hostOrigin === undefined) return false;
  try {
    return allowed.includes(new URL(hostOrigin).origin);
  } catch {
    return false;
  }
}

/**
 * The pages that may frame a brand's widget (the page's CSP `frame-ancestors`): its allowed
 * websites, or local pages while it has none. A test chat adds Studio, and nothing else does.
 */
export function frameAncestors(
  allowed: readonly string[],
  test: { studioOrigin: string } | null,
): string[] {
  const base = allowed.length > 0 ? [...allowed] : LOCAL_ANCESTORS;
  if (!test) return base;
  try {
    const studio = new URL(test.studioOrigin).origin;
    return base.includes(studio) ? base : [...base, studio];
  } catch {
    return base;
  }
}

/** What a session from the brand's direct chat link (W28) stores as its origin. */
export const DIRECT_ORIGIN = 'direct';

/**
 * The website a session came from, as an origin. Sessions store "unknown" when the page did not
 * say where it was, and "direct" when the chat was opened from the brand's link: neither is a
 * website.
 */
export const sessionOrigin = (stored: string): string | undefined =>
  stored === 'unknown' || stored === DIRECT_ORIGIN ? undefined : stored;
