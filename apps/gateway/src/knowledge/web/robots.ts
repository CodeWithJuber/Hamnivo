import robotsModule from 'robots-parser';

// The package is CommonJS (`module.exports = fn`), so Node hands the function over as the default
// import; its typings describe an ES module with a `default` export instead.
const robotsParser = robotsModule as unknown as typeof robotsModule.default;

/** How Hamnivo's website reader names itself: in robots.txt, and in every request it sends. */
export const CRAWLER_TOKEN = 'HamnivoBot';
export const CRAWLER_AGENT = `${CRAWLER_TOKEN}/1.0 (reads websites for their owner's knowledge base; follows robots.txt)`;

export interface Robots {
  /**
   * `read`: the site's robots.txt was read. `missing`: the site has none (a 4xx answer), so
   * everything is allowed. `unreadable`: it could not be read (a server error, no answer), so
   * nothing is, as RFC 9309 says.
   */
  status: 'read' | 'missing' | 'unreadable';
  allows(url: string): boolean;
  /** Seconds the site asks to wait between requests, as milliseconds; 0 when it did not say. */
  crawlDelayMs: number;
  /** Sitemaps the site names (`Sitemap:` lines), as written. */
  sitemaps: string[];
}

export function openRobots(): Robots {
  return { status: 'missing', allows: () => true, crawlDelayMs: 0, sitemaps: [] };
}

export function closedRobots(): Robots {
  return { status: 'unreadable', allows: () => false, crawlDelayMs: 0, sitemaps: [] };
}

/** Reads the text of a robots.txt for a site (the address of the file names the site). */
export function parseRobots(robotsUrl: string, text: string): Robots {
  const robots = robotsParser(robotsUrl, text);
  const delay = robots.getCrawlDelay(CRAWLER_TOKEN);
  return {
    status: 'read',
    allows: (url) => robots.isAllowed(url, CRAWLER_TOKEN) !== false,
    crawlDelayMs: typeof delay === 'number' && delay > 0 ? Math.round(delay * 1000) : 0,
    sitemaps: robots.getSitemaps(),
  };
}
