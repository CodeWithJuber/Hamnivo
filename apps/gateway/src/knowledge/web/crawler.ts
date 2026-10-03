import type { IncomingHttpHeaders } from 'node:http';
import { EgressError } from '@hamnivo/adapters/net';
import { KNOWLEDGE_MAX_BYTES } from '@hamnivo/contracts';
import { BodyError, gunzip, toUtf8, unpack } from './body.js';
import { scanPage } from './html.js';
import { CRAWLER_AGENT, closedRobots, openRobots, parseRobots, type Robots } from './robots.js';
import { parseSitemap } from './sitemap.js';
import { folderOf, inFolder, looksLikePage, normalizePageUrl, samePath, sameSite } from './urls.js';

/** What a read of a website may do: where it starts and how far it goes. */
export interface CrawlPlan {
  startUrl: string;
  /** `page`: only the start address. `site`: its sitemap and the links between its pages. */
  mode: 'page' | 'site';
  maxPages: number;
  maxDepth: number;
}

export interface Fetched {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was longer than the limit that was asked for. */
  truncated: boolean;
}

/** One request, under the egress policy (it throws an EgressError when refused or failed). */
export type RequestFn = (
  url: string,
  options: { headers: Record<string, string>; maxBytes: number },
) => Promise<Fetched>;

export type SkipReason = 'robots' | 'offsite' | 'noindex' | 'type' | 'duplicate' | 'empty';

/** What happened to one address, as the crawl found it. */
export type PageOutcome =
  | {
      kind: 'page';
      url: string;
      depth: number;
      mediaType: 'text/html' | 'application/pdf';
      /** UTF-8 for HTML, as received for PDF. */
      body: Buffer;
      title: string | null;
      etag: string | null;
      lastModified: string | null;
      status: number;
    }
  | { kind: 'not_modified'; url: string; depth: number }
  | { kind: 'gone'; url: string; depth: number; status: number }
  | { kind: 'failed'; url: string; depth: number; reason: string; status: number | null }
  | { kind: 'skipped'; url: string; depth: number; reason: SkipReason };

export interface CrawlDeps {
  request: RequestFn;
  /** What the last read learned about an address, for a conditional request. */
  known(url: string): { etag: string | null; lastModified: string | null } | undefined;
  /**
   * Hands over one outcome. For a page it answers whether the page was kept (readable text, so it
   * counts toward the limit); anything else counts as nothing.
   */
  onOutcome(outcome: PageOutcome): Promise<boolean>;
  /** At least this long between two requests to the site (robots.txt may ask for longer). */
  delayMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** No request is made after this time (epoch milliseconds). */
  deadline: number;
}

/**
 * Why a read ended. `done`: nothing was left to read. `pages`: the page limit was reached with
 * pages still waiting. `time`: the time limit. `budget`: too many requests for the pages that came
 * of them. `trouble`: the site kept failing, so the reader stopped being a nuisance.
 */
export type CrawlStop = 'done' | 'pages' | 'time' | 'budget' | 'trouble';

export interface CrawlReport {
  robots: Robots['status'];
  /** Sitemap files that were read. */
  sitemaps: number;
  stopped: CrawlStop;
  /** Addresses that were looked at (kept or not). */
  visited: number;
  /** Whether the site's robots.txt lets the reader fetch an address (all of them when it has none). */
  allows(url: string): boolean;
}

/** A read of a page can be larger than this only for a PDF; HTML is capped lower. */
const PAGE_BYTES = 2 * 1024 * 1024;
const PDF_BYTES = KNOWLEDGE_MAX_BYTES;
const ROBOTS_BYTES = 512 * 1024;
const SITEMAP_BYTES = 10 * 1024 * 1024;
const MAX_SITEMAP_FILES = 20;
const MAX_REDIRECTS = 5;
const MAX_DELAY_MS = 10_000;
const MAX_QUEUE = 5000;
/** Failures in a row (a site that is down or refusing) after which the read gives up. */
const MAX_FAILURES_IN_A_ROW = 8;
const ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1';

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The words for a request that failed, safe to show: never what the site said. */
function failure(error: unknown): string {
  if (error instanceof EgressError) {
    switch (error.problem) {
      case 'timeout':
        return 'The site did not answer in time.';
      case 'response_too_large':
        return 'The page is too large.';
      case 'tls':
        return 'The secure connection to the site could not be made.';
      case 'host_not_allowed':
        return 'This site is not on the list of allowed hosts.';
      case 'network':
      case 'unresolvable':
        return 'The site could not be reached.';
      default:
        return 'Hamnivo is not allowed to reach this address.';
    }
  }
  if (error instanceof BodyError) return error.message;
  return 'The page could not be read.';
}

/** What a site that answers every address with a move to another site is told. */
const moved = (host: string) => `The address sends visitors to ${host}. Add that address instead.`;

/**
 * Reads a website the way its owner would want a polite visitor to: the site's robots.txt first,
 * then its sitemap and the links between its pages, one request at a time, never leaving the site
 * or the folder the read started from, never past the limits. Every request goes through the
 * egress policy in `deps.request`; the crawl decides what to ask for and what each answer means.
 */
export async function crawlSite(plan: CrawlPlan, deps: CrawlDeps): Promise<CrawlReport> {
  const start = normalizePageUrl(plan.startUrl);
  if (!start) throw new Error('The start address is not a web address.');
  const origin = new URL(start).origin;
  const folder = plan.mode === 'site' ? folderOf(start) : '/';
  let requests = 0;
  let first = true;
  let delay = deps.delayMs;

  /** One polite request: waits its turn, and says who is asking. */
  const ask = async (
    url: string,
    maxBytes: number,
    extra: Record<string, string> = {},
  ): Promise<Fetched> => {
    if (!first) await deps.sleep(delay);
    first = false;
    requests += 1;
    return deps.request(url, {
      headers: {
        'user-agent': CRAWLER_AGENT,
        accept: ACCEPT,
        'accept-encoding': 'gzip, deflate, br',
        ...extra,
      },
      maxBytes,
    });
  };

  type Followed =
    | { res: Fetched; url: string }
    | { skipped: SkipReason; to: string }
    | { failed: string };

  /** A request that follows redirects within the site, and says where it ended. */
  const follow = async (
    url: string,
    maxBytes: number,
    extra: Record<string, string> = {},
  ): Promise<Followed> => {
    let current = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
      let res: Fetched;
      try {
        res = await ask(current, maxBytes, hops === 0 ? extra : {});
      } catch (error) {
        return { failed: failure(error) };
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) return { res, url: current };
      const location = header(res.headers, 'location');
      const target = location ? normalizePageUrl(location, current) : null;
      if (!target) return { failed: 'The site sent the reader somewhere that is not an address.' };
      if (!sameSite(target, origin)) return { skipped: 'offsite', to: new URL(target).host };
      current = target;
    }
    return { failed: 'The site sent the reader around in circles.' };
  };

  const startFailed = (reason: string) =>
    deps.onOutcome({ kind: 'failed', url: start, depth: 0, reason, status: null });

  // robots.txt first: a site that cannot be asked is not read.
  let robots: Robots = openRobots();
  let robotsProblem = '';
  {
    const found = await follow(`${origin}/robots.txt`, ROBOTS_BYTES);
    if ('skipped' in found) {
      await startFailed(moved(found.to));
      return {
        robots: 'unreadable',
        sitemaps: 0,
        stopped: 'done',
        visited: 0,
        allows: () => false,
      };
    }
    if ('res' in found) {
      if (found.res.status >= 200 && found.res.status < 300) {
        const text = toUtf8(found.res.body, header(found.res.headers, 'content-type')).toString(
          'utf8',
        );
        robots = parseRobots(`${origin}/robots.txt`, text);
      } else if (found.res.status >= 500 || found.res.status === 429) {
        robots = closedRobots();
        robotsProblem = `The site answered ${found.res.status}.`;
      }
    } else {
      robots = closedRobots();
      robotsProblem = found.failed;
    }
  }
  if (robots.status === 'unreadable') {
    await startFailed(
      `The site’s robots.txt could not be read, so nothing was read. ${robotsProblem}`,
    );
    return { robots: 'unreadable', sitemaps: 0, stopped: 'done', visited: 0, allows: () => false };
  }
  delay = Math.min(MAX_DELAY_MS, Math.max(deps.delayMs, robots.crawlDelayMs));

  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const queued = new Set<string>([start]);
  const consider = (url: string | null, depth: number) => {
    if (!url || queued.has(url) || queue.length >= MAX_QUEUE) return;
    if (!sameSite(url, origin) || !inFolder(url, folder) || !looksLikePage(url)) return;
    queued.add(url);
    queue.push({ url, depth });
  };

  // The sitemap lists what the site wants read, at the start (depth 0).
  let sitemapFiles = 0;
  if (plan.mode === 'site') {
    const roots = [
      ...new Set(
        robots.sitemaps
          .map((address) => normalizePageUrl(address, origin))
          .filter((address): address is string => address !== null && sameSite(address, origin)),
      ),
    ];
    const todo = roots.length > 0 ? roots : [`${origin}/sitemap.xml`];
    const done = new Set<string>();
    while (todo.length > 0 && sitemapFiles < MAX_SITEMAP_FILES && deps.now() < deps.deadline) {
      const address = todo.shift() as string;
      if (done.has(address)) continue;
      done.add(address);
      if (!robots.allows(address)) continue;
      const found = await follow(address, SITEMAP_BYTES);
      if (!('res' in found) || found.res.status < 200 || found.res.status >= 300) continue;
      sitemapFiles += 1;
      let xml: string;
      try {
        xml = gunzip(
          unpack(found.res.body, header(found.res.headers, 'content-encoding'), SITEMAP_BYTES),
          SITEMAP_BYTES,
        ).toString('utf8');
      } catch {
        continue;
      }
      const contents = parseSitemap(xml);
      for (const child of contents.sitemaps) {
        const url = normalizePageUrl(child, address);
        if (url && sameSite(url, origin) && !done.has(url)) todo.push(url);
      }
      for (const loc of contents.urls) consider(normalizePageUrl(loc, address), 0);
    }
  }

  let kept = 0;
  let visited = 0;
  let failuresInARow = 0;
  let stopped: CrawlStop = 'done';
  const budget = plan.maxPages * 3 + 20;
  while (queue.length > 0) {
    if (kept >= plan.maxPages) stopped = 'pages';
    else if (deps.now() >= deps.deadline) stopped = 'time';
    else if (requests >= budget) stopped = 'budget';
    else if (failuresInARow >= MAX_FAILURES_IN_A_ROW) stopped = 'trouble';
    if (stopped !== 'done') break;

    const entry = queue.shift() as { url: string; depth: number };
    visited += 1;
    const { depth } = entry;
    const skip = (url: string, reason: SkipReason) =>
      deps.onOutcome({ kind: 'skipped', url, depth, reason });
    const fail = (url: string, reason: string, status: number | null) => {
      failuresInARow += 1;
      return deps.onOutcome({ kind: 'failed', url, depth, reason, status });
    };
    if (!robots.allows(entry.url)) {
      await skip(entry.url, 'robots');
      continue;
    }
    const conditions: Record<string, string> = {};
    const known = deps.known(entry.url);
    if (known?.etag) conditions['if-none-match'] = known.etag;
    else if (known?.lastModified) conditions['if-modified-since'] = known.lastModified;

    const found = await follow(entry.url, PDF_BYTES, conditions);
    if ('skipped' in found) {
      if (entry.url === start) await fail(entry.url, moved(found.to), null);
      else await skip(entry.url, found.skipped);
      continue;
    }
    if ('failed' in found) {
      await fail(entry.url, found.failed, null);
      continue;
    }
    const { res, url: finalUrl } = found;
    if (finalUrl !== entry.url) {
      // A redirect inside the site: the page counts once, under the address it ended at.
      if (queued.has(finalUrl)) {
        await skip(entry.url, 'duplicate');
        continue;
      }
      if (!robots.allows(finalUrl) || !inFolder(finalUrl, folder)) {
        await skip(entry.url, robots.allows(finalUrl) ? 'offsite' : 'robots');
        continue;
      }
      queued.add(finalUrl);
    }
    if (res.status === 304) {
      failuresInARow = 0;
      if (await deps.onOutcome({ kind: 'not_modified', url: finalUrl, depth })) kept += 1;
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      failuresInARow = 0;
      await deps.onOutcome({ kind: 'gone', url: finalUrl, depth, status: res.status });
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      // A site that says it is being asked too often, or is struggling, gets longer pauses.
      if (res.status === 429 || res.status === 503)
        delay = Math.min(MAX_DELAY_MS, delay * 2 || 1000);
      await fail(
        finalUrl,
        res.status === 401 || res.status === 403
          ? 'The site asked for a sign-in or refused the reader.'
          : res.status === 429
            ? 'The site said it is being asked too often.'
            : `The site answered ${res.status}.`,
        res.status,
      );
      continue;
    }
    if (res.truncated) {
      await fail(finalUrl, 'The page is too large.', res.status);
      continue;
    }
    const type = (header(res.headers, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (/\b(noindex|none)\b/.test((header(res.headers, 'x-robots-tag') ?? '').toLowerCase())) {
      await skip(finalUrl, 'noindex');
      continue;
    }
    const etag = header(res.headers, 'etag') ?? null;
    const lastModified = header(res.headers, 'last-modified') ?? null;
    let body: Buffer;
    try {
      body = unpack(res.body, header(res.headers, 'content-encoding'), PDF_BYTES);
    } catch (error) {
      await fail(finalUrl, failure(error), res.status);
      continue;
    }
    failuresInARow = 0;
    if (type === 'application/pdf') {
      const accepted = await deps.onOutcome({
        kind: 'page',
        url: finalUrl,
        depth,
        mediaType: 'application/pdf',
        body,
        title: null,
        etag,
        lastModified,
        status: res.status,
      });
      if (accepted) kept += 1;
      continue;
    }
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      await skip(finalUrl, 'type');
      continue;
    }
    if (body.length > PAGE_BYTES) {
      await fail(finalUrl, 'The page is too large.', res.status);
      continue;
    }
    const html = toUtf8(body, header(res.headers, 'content-type'));
    const info = scanPage(html.toString('utf8'), finalUrl);
    if (info.noindex) {
      await skip(finalUrl, 'noindex');
      continue;
    }
    // A page that names a variant of its own address as its main one (tracking or paging
    // parameters) is that page, read under the main address. A canonical link to some other path is
    // left alone: sites set it wrongly often enough that following it would hide real pages.
    if (
      info.canonical &&
      info.canonical !== finalUrl &&
      sameSite(info.canonical, origin) &&
      samePath(info.canonical, finalUrl)
    ) {
      consider(info.canonical, depth);
      await skip(finalUrl, 'duplicate');
      continue;
    }
    const accepted = await deps.onOutcome({
      kind: 'page',
      url: finalUrl,
      depth,
      mediaType: 'text/html',
      body: html,
      title: info.title,
      etag,
      lastModified,
      status: res.status,
    });
    if (accepted) kept += 1;
    if (plan.mode === 'site' && !info.nofollow && depth < plan.maxDepth) {
      for (const link of info.links) consider(link.url, depth + 1);
    }
  }
  return { robots: robots.status, sitemaps: sitemapFiles, stopped, visited, allows: robots.allows };
}
