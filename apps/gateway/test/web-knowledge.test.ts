import { gzipSync } from 'node:zlib';
import { EgressError } from '@hamnivo/adapters/net';
import { describe, expect, it } from 'vitest';
import { BodyError, gunzip, toUtf8, unpack } from '../src/knowledge/web/body.js';
import {
  type CrawlDeps,
  type CrawlPlan,
  type CrawlReport,
  crawlSite,
  type Fetched,
  type PageOutcome,
  type RequestFn,
} from '../src/knowledge/web/crawler.js';
import { scanPage } from '../src/knowledge/web/html.js';
import { CRAWLER_AGENT, parseRobots } from '../src/knowledge/web/robots.js';
import { parseSitemap } from '../src/knowledge/web/sitemap.js';
import {
  folderOf,
  inFolder,
  looksLikePage,
  nameFromUrl,
  normalizePageUrl,
  samePath,
  sameSite,
} from '../src/knowledge/web/urls.js';

/**
 * Reading a website as knowledge (G04): the pieces that decide what is read, with a made-up site
 * in memory and no network. The whole read, from the egress guard to the indexed passages, is in
 * web-knowledge.int.test.ts.
 */

const ORIGIN = 'https://shop.test';
const at = (path: string) => `${ORIGIN}${path}`;

type Reply = {
  status?: number;
  type?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
};

const page = (title: string, links: string[] = [], extra = '') =>
  `<!doctype html><html><head><title>${title}</title>${extra}</head><body><h1>${title}</h1><p>Words about ${title}.</p>${links
    .map((href) => `<a href="${href}">link</a>`)
    .join('')}</body></html>`;

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join('')}</urlset>`;

function made(status: number, headers: Record<string, string>, body: string | Buffer): Fetched {
  return {
    status,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    truncated: false,
  };
}

/** A site that lives in memory: what each address answers, and every request it received. */
function site(routes: Record<string, Reply | ((headers: Record<string, string>) => Reply)>) {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const request: RequestFn = async (url, { headers }) => {
    log.push({ url, headers });
    const entry = routes[url];
    if (entry === undefined) return made(404, { 'content-type': 'text/html' }, 'not found');
    const reply = typeof entry === 'function' ? entry(headers) : entry;
    return made(
      reply.status ?? 200,
      { 'content-type': reply.type ?? 'text/html; charset=utf-8', ...reply.headers },
      reply.body ?? '',
    );
  };
  return { request, log, urls: () => log.map((entry) => entry.url) };
}

interface Result {
  report: CrawlReport;
  outcomes: PageOutcome[];
  sleeps: number[];
  pages: string[];
}

async function read(
  request: RequestFn,
  plan: Partial<CrawlPlan> = {},
  deps: Partial<CrawlDeps> = {},
): Promise<Result> {
  const outcomes: PageOutcome[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const report = await crawlSite(
    { startUrl: at('/'), mode: 'site', maxPages: 50, maxDepth: 2, ...plan },
    {
      request,
      known: () => undefined,
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
        return outcome.kind === 'page' || outcome.kind === 'not_modified';
      },
      delayMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => (clock += 1),
      deadline: Number.MAX_SAFE_INTEGER,
      ...deps,
    },
  );
  const pages = outcomes.filter((o) => o.kind === 'page').map((o) => o.url);
  return { report, outcomes, sleeps, pages };
}

const skipped = (result: Result, reason: string) =>
  result.outcomes.filter((o) => o.kind === 'skipped' && o.reason === reason).map((o) => o.url);

describe('addresses', () => {
  it('names a page once: no fragment, host in lower case, no default port', () => {
    expect(normalizePageUrl('HTTPS://Shop.Test:443/Help/#top')).toBe('https://shop.test/Help/');
    expect(normalizePageUrl('/returns?x=1#a', 'https://shop.test/help/')).toBe(
      'https://shop.test/returns?x=1',
    );
    expect(normalizePageUrl('../faq', 'https://shop.test/help/a/b')).toBe(
      'https://shop.test/help/faq',
    );
  });

  it('refuses what is not a plain web address', () => {
    for (const href of [
      'mailto:a@b.test',
      'javascript:alert(1)',
      'ftp://shop.test/a',
      'data:text/html,hi',
      'https://user:pass@shop.test/',
      'not a url',
    ]) {
      expect(normalizePageUrl(href), href).toBeNull();
    }
    expect(normalizePageUrl(`https://shop.test/${'a'.repeat(2100)}`)).toBeNull();
  });

  it('keeps a read to the site and folder it started from', () => {
    expect(sameSite('https://shop.test/a', 'https://shop.test/b')).toBe(true);
    expect(sameSite('https://shop.test/a', 'http://shop.test/a')).toBe(false);
    expect(sameSite('https://shop.test/a', 'https://www.shop.test/a')).toBe(false);
    expect(sameSite('https://shop.test:8443/a', 'https://shop.test/a')).toBe(false);
    expect(folderOf('https://shop.test/')).toBe('/');
    expect(folderOf('https://shop.test/help')).toBe('/help/');
    expect(folderOf('https://shop.test/help/')).toBe('/help/');
    expect(folderOf('https://shop.test/help/start.html')).toBe('/help/');
    expect(folderOf('https://shop.test/help/index.html')).toBe('/help/');
    expect(folderOf('https://shop.test/index.html')).toBe('/');
    expect(inFolder('https://shop.test/help/a', '/help/')).toBe(true);
    expect(inFolder('https://shop.test/helpdesk/a', '/help/')).toBe(false);
    expect(inFolder('https://shop.test/about', '/help/')).toBe(false);
  });

  it('follows links to pages, not to pictures, scripts or archives', () => {
    expect(looksLikePage('https://shop.test/returns')).toBe(true);
    expect(looksLikePage('https://shop.test/guide.pdf')).toBe(true);
    for (const file of ['logo.png', 'app.js', 'site.css', 'all.zip', 'feed.xml', 'a.docx']) {
      expect(looksLikePage(`https://shop.test/${file}`), file).toBe(false);
    }
    expect(samePath('https://shop.test/a/?utm=1', 'https://shop.test/a')).toBe(true);
    expect(samePath('https://shop.test/a', 'https://shop.test/b')).toBe(false);
  });

  it('gives a page without a title a readable name', () => {
    expect(nameFromUrl('https://shop.test/help/return-policy.html')).toBe('return policy');
    expect(nameFromUrl('https://shop.test/')).toBe('shop.test');
  });
});

describe('what a page says about itself', () => {
  it('reads the title (or first heading) and resolves links against the page', () => {
    const info = scanPage(
      page('Returns', ['/help', 'faq', '#top', 'mailto:a@b.test', '/help'], ''),
      'https://shop.test/policies/returns',
    );
    expect(info.title).toBe('Returns');
    expect(info.links.map((l) => l.url)).toEqual([
      'https://shop.test/help',
      'https://shop.test/policies/faq',
      'https://shop.test/policies/returns',
    ]);
    expect(scanPage('<h1> Welcome  home </h1>', 'https://shop.test/').title).toBe('Welcome home');
    expect(scanPage('<p>no heading</p>', 'https://shop.test/').title).toBeNull();
  });

  it('notices noindex, nofollow, nofollow links and a canonical address', () => {
    const info = scanPage(
      `<meta name="robots" content="noindex, nofollow"><link rel="canonical" href="/a"><a rel="nofollow" href="/x">x</a><a href="/y">y</a>`,
      'https://shop.test/a?utm=1',
    );
    expect(info).toMatchObject({
      noindex: true,
      nofollow: true,
      canonical: 'https://shop.test/a',
    });
    expect(info.links.map((l) => l.url)).toEqual(['https://shop.test/y']);
    expect(
      scanPage('<meta name="HamnivoBot" content="noindex">', 'https://shop.test/').noindex,
    ).toBe(true);
    expect(
      scanPage('<meta name="googlebot" content="noindex">', 'https://shop.test/').noindex,
    ).toBe(false);
  });
});

describe('sitemaps', () => {
  it('lists the pages of a urlset and the sitemaps of an index', () => {
    expect(parseSitemap(urlset('https://shop.test/a', ' https://shop.test/b '))).toEqual({
      kind: 'urlset',
      urls: ['https://shop.test/a', 'https://shop.test/b'],
      sitemaps: [],
    });
    const index = parseSitemap(
      '<sitemapindex><sitemap><loc>https://shop.test/s1.xml</loc></sitemap></sitemapindex>',
    );
    expect(index).toMatchObject({ kind: 'index', sitemaps: ['https://shop.test/s1.xml'] });
  });

  it('never expands what a hostile sitemap defines', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset><url><loc>&xxe;</loc></url><url><loc>https://shop.test/ok</loc></url></urlset>`;
    const result = parseSitemap(xml);
    expect(result.urls.join('')).not.toContain('root:');
    expect(result.urls).toContain('https://shop.test/ok');
  });

  it('ignores a loc that is not under url or sitemap', () => {
    expect(
      parseSitemap('<urlset><image><loc>https://shop.test/pic</loc></image></urlset>').urls,
    ).toEqual([]);
  });
});

describe('robots.txt', () => {
  const robots = parseRobots(
    at('/robots.txt'),
    [
      'User-agent: *',
      'Disallow: /private/',
      'Allow: /private/open',
      'Crawl-delay: 3',
      'Sitemap: https://shop.test/sitemap.xml',
      '',
      'User-agent: HamnivoBot',
      'Disallow: /secret',
      'Crawl-delay: 5',
    ].join('\n'),
  );

  it('uses the group written for the reader, and the delay and sitemaps the file names', () => {
    expect(robots.allows(at('/secret/page'))).toBe(false);
    expect(robots.allows(at('/private/page'))).toBe(true);
    expect(robots.crawlDelayMs).toBe(5000);
    expect(robots.sitemaps).toEqual(['https://shop.test/sitemap.xml']);
  });

  it('applies the general group when none is written for the reader', () => {
    const general = parseRobots(
      at('/robots.txt'),
      'User-agent: *\nDisallow: /private/\nAllow: /private/open',
    );
    expect(general.allows(at('/private/page'))).toBe(false);
    expect(general.allows(at('/private/open'))).toBe(true);
    expect(general.allows(at('/public'))).toBe(true);
    expect(general.crawlDelayMs).toBe(0);
  });

  it('names the reader in every request', () => {
    expect(CRAWLER_AGENT).toContain('HamnivoBot');
  });
});

describe('response bodies', () => {
  it('unpacks gzip, deflate and brotli, never past the limit', () => {
    const text = Buffer.from('hello world '.repeat(100));
    expect(unpack(gzipSync(text), 'gzip', 10_000).equals(text)).toBe(true);
    expect(unpack(text, undefined, 10).equals(text)).toBe(true);
    expect(() => unpack(gzipSync(Buffer.alloc(200_000)), 'gzip', 1000)).toThrow(BodyError);
    expect(() => unpack(Buffer.from('not gzip'), 'gzip', 1000)).toThrow(BodyError);
    expect(() => unpack(text, 'compress', 1000)).toThrow(BodyError);
  });

  it('unpacks a .gz sitemap whatever the server said about it', () => {
    const xml = Buffer.from(urlset('https://shop.test/a'));
    expect(gunzip(gzipSync(xml), 1_000_000).equals(xml)).toBe(true);
    expect(gunzip(xml, 1_000_000).equals(xml)).toBe(true);
  });

  it('turns a page in another character set into UTF-8 text', () => {
    // "café" in ISO-8859-1, and "سلام" in Windows-1256, as the header and the page declare.
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(toUtf8(latin, 'text/html; charset=iso-8859-1').toString('utf8')).toBe('café');
    const arabic = Buffer.from([0xd3, 0xe1, 0xc7, 0xe3]);
    expect(
      toUtf8(
        Buffer.concat([Buffer.from('<meta charset="windows-1256">'), arabic]),
        'text/html',
      ).toString('utf8'),
    ).toContain('سلام');
    // Bytes that are not valid UTF-8 become replacement characters instead of an error.
    expect(toUtf8(Buffer.from([0x61, 0xff, 0x62]), 'text/html').toString('utf8')).toBe('a�b');
    // An unknown character set falls back to UTF-8.
    expect(toUtf8(Buffer.from('ok'), 'text/html; charset=made-up-9').toString('utf8')).toBe('ok');
  });
});

describe('reading a site', () => {
  it('asks robots.txt first, then the sitemap, then the pages, and waits as the site asks', async () => {
    const fake = site({
      [at('/robots.txt')]: {
        type: 'text/plain',
        body: `User-agent: *\nDisallow: /private/\nCrawl-delay: 2\nSitemap: ${at('/sitemap.xml')}`,
      },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/'), at('/returns'), at('/private/secret'), 'https://other.test/x'),
      },
      [at('/')]: { body: page('Home') },
      [at('/returns')]: { body: page('Returns') },
    });
    const result = await read(fake.request);
    expect(fake.urls()).toEqual([at('/robots.txt'), at('/sitemap.xml'), at('/'), at('/returns')]);
    expect(result.pages).toEqual([at('/'), at('/returns')]);
    expect(skipped(result, 'robots')).toEqual([at('/private/secret')]);
    // Never a request for the page robots.txt disallows or for another site.
    expect(fake.urls()).not.toContain(at('/private/secret'));
    expect(fake.urls()).not.toContain('https://other.test/x');
    expect(result.sleeps).toEqual([2000, 2000, 2000]);
    expect(result.report).toMatchObject({ robots: 'read', sitemaps: 1, stopped: 'done' });
    expect(fake.log.every((entry) => entry.headers['user-agent'] === CRAWLER_AGENT)).toBe(true);
  });

  it('finds the sitemap at /sitemap.xml when robots.txt does not name one, and reads indexes and .gz files', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: `<sitemapindex><sitemap><loc>${at('/s1.xml.gz')}</loc></sitemap><sitemap><loc>https://other.test/s.xml</loc></sitemap></sitemapindex>`,
      },
      [at('/s1.xml.gz')]: {
        type: 'application/gzip',
        body: gzipSync(Buffer.from(urlset(at('/a'), at('/b')))),
      },
      [at('/')]: { body: page('Home') },
      [at('/a')]: { body: page('A') },
      [at('/b')]: { body: page('B') },
    });
    const result = await read(fake.request);
    expect(result.pages).toEqual([at('/'), at('/a'), at('/b')]);
    expect(result.report).toMatchObject({ robots: 'missing', sitemaps: 2 });
    expect(fake.urls()).not.toContain('https://other.test/s.xml');
  });

  it('follows links within the depth limit and never leaves the site or the folder', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: { status: 404 },
      [at('/help/')]: {
        body: page('Help', [
          '/help/a',
          '/about',
          'https://other.test/',
          '/help/b#frag',
          '/help/logo.png',
        ]),
      },
      [at('/help/a')]: { body: page('A', ['/help/c']) },
      [at('/help/b')]: { body: page('B') },
      [at('/help/c')]: { body: page('C') },
      [at('/about')]: { body: page('About') },
    });
    const result = await read(fake.request, { startUrl: at('/help/'), maxDepth: 1 });
    expect(result.pages).toEqual([at('/help/'), at('/help/a'), at('/help/b')]);
    expect(fake.urls()).not.toContain(at('/about'));
    expect(fake.urls()).not.toContain(at('/help/c'));
    expect(fake.urls()).not.toContain(at('/help/logo.png'));
    expect(result.outcomes.find((o) => o.url === at('/help/a'))).toMatchObject({ depth: 1 });
  });

  it('reads just the address given in page mode', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/guide')]: { body: page('Guide', ['/other']) },
      [at('/other')]: { body: page('Other') },
    });
    const result = await read(fake.request, { startUrl: at('/guide'), mode: 'page' });
    expect(result.pages).toEqual([at('/guide')]);
    expect(fake.urls()).toEqual([at('/robots.txt'), at('/guide')]);
  });

  it('stops at the page limit and says so', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/'), at('/a'), at('/b'), at('/c'), at('/d')),
      },
      [at('/')]: { body: page('Home') },
      [at('/a')]: { body: page('A') },
      [at('/b')]: { body: page('B') },
      [at('/c')]: { body: page('C') },
      [at('/d')]: { body: page('D') },
    });
    const result = await read(fake.request, { maxPages: 2 });
    expect(result.pages).toEqual([at('/'), at('/a')]);
    expect(result.report.stopped).toBe('pages');
  });

  it('does not read a site whose robots.txt cannot be read, and says why', async () => {
    for (const reply of [{ status: 503 }, { status: 500 }]) {
      const fake = site({ [at('/robots.txt')]: reply, [at('/')]: { body: page('Home') } });
      const result = await read(fake.request);
      expect(fake.urls()).toEqual([at('/robots.txt')]);
      expect(result.report.robots).toBe('unreadable');
      expect(result.outcomes).toMatchObject([
        { kind: 'failed', url: at('/'), reason: expect.stringContaining('robots.txt') },
      ]);
    }
    const down: RequestFn = async () => {
      throw new EgressError('network', 'The connection failed.');
    };
    const result = await read(down);
    expect(result.report.robots).toBe('unreadable');
  });

  it('reads a site without robots.txt, and a site whose robots.txt asks to be left alone is left alone', async () => {
    const open = site({ [at('/robots.txt')]: { status: 404 }, [at('/')]: { body: page('Home') } });
    expect((await read(open.request, { mode: 'page' })).pages).toEqual([at('/')]);

    const closed = site({
      [at('/robots.txt')]: { type: 'text/plain', body: 'User-agent: *\nDisallow: /' },
      [at('/')]: { body: page('Home') },
    });
    const result = await read(closed.request);
    expect(result.pages).toEqual([]);
    expect(skipped(result, 'robots')).toEqual([at('/')]);
    // Not even the sitemap is asked for: robots.txt covers it too.
    expect(closed.urls()).toEqual([at('/robots.txt')]);
  });

  it('tells a person whose address moves to another site where it went', async () => {
    const fake = site({
      [at('/robots.txt')]: {
        status: 301,
        headers: { location: 'https://www.shop.test/robots.txt' },
      },
    });
    const result = await read(fake.request);
    expect(result.outcomes).toMatchObject([
      {
        kind: 'failed',
        url: at('/'),
        reason: 'The address sends visitors to www.shop.test. Add that address instead.',
      },
    ]);
    expect(fake.urls()).toEqual([at('/robots.txt')]);
  });

  it('follows a redirect inside the site and counts the page once, under its final address', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/old'), at('/new')),
      },
      [at('/')]: { body: page('Home') },
      [at('/old')]: { status: 301, headers: { location: '/new' } },
      [at('/new')]: { body: page('New') },
    });
    const result = await read(fake.request);
    expect(result.pages).toEqual([at('/'), at('/new')]);
    // /old ended at /new, which the sitemap also lists: one page, one outcome for the copy.
    expect(skipped(result, 'duplicate')).toContain(at('/old'));
  });

  it('gives up on a redirect that goes round in circles or leaves the site', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/'), at('/loop'), at('/away')),
      },
      [at('/')]: { body: page('Home') },
      [at('/loop')]: { status: 302, headers: { location: '/loop' } },
      [at('/away')]: { status: 302, headers: { location: 'https://other.test/x' } },
    });
    const result = await read(fake.request);
    expect(result.pages).toEqual([at('/')]);
    expect(result.outcomes.find((o) => o.url === at('/loop'))).toMatchObject({ kind: 'failed' });
    expect(skipped(result, 'offsite')).toEqual([at('/away')]);
    expect(fake.urls()).not.toContain('https://other.test/x');
  });

  it('leaves out pages that ask not to be indexed, other file types and copies of a page', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(
          at('/'),
          at('/hidden'),
          at('/header-hidden'),
          at('/data'),
          at('/doc.pdf'),
          at('/variant?utm=1'),
        ),
      },
      [at('/')]: { body: page('Home') },
      [at('/hidden')]: { body: page('Hidden', [], '<meta name="robots" content="noindex">') },
      [at('/header-hidden')]: { body: page('Header'), headers: { 'x-robots-tag': 'noindex' } },
      [at('/data')]: { type: 'application/json', body: '{"a":1}' },
      [at('/doc.pdf')]: { type: 'application/pdf', body: Buffer.from('%PDF-1.4 fake') },
      [at('/variant?utm=1')]: {
        body: page('Variant', [], `<link rel="canonical" href="${at('/variant')}">`),
      },
      [at('/variant')]: { body: page('Variant') },
    });
    const result = await read(fake.request);
    expect(result.pages).toEqual([at('/'), at('/doc.pdf'), at('/variant')]);
    expect(skipped(result, 'noindex')).toEqual([at('/hidden'), at('/header-hidden')]);
    expect(skipped(result, 'type')).toEqual([at('/data')]);
    expect(skipped(result, 'duplicate')).toEqual([at('/variant?utm=1')]);
    expect(result.outcomes.find((o) => o.url === at('/doc.pdf'))).toMatchObject({
      mediaType: 'application/pdf',
      title: null,
    });
  });

  it('does not follow a canonical link to some other path', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: { type: 'application/xml', body: urlset(at('/'), at('/a'), at('/b')) },
      [at('/')]: { body: page('Home', [], `<link rel="canonical" href="${at('/')}">`) },
      [at('/a')]: { body: page('A', [], `<link rel="canonical" href="${at('/')}">`) },
      [at('/b')]: { body: page('B', [], `<link rel="canonical" href="${at('/')}">`) },
    });
    expect((await read(fake.request)).pages).toEqual([at('/'), at('/a'), at('/b')]);
  });

  it('asks again only for what changed: conditional requests and not-modified answers', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/')]: (headers) =>
        headers['if-none-match'] === '"v1"'
          ? { status: 304, body: '' }
          : { body: page('Home'), headers: { etag: '"v1"' } },
      [at('/dated')]: (headers) =>
        headers['if-modified-since'] === 'Mon, 01 Jan 2024 00:00:00 GMT'
          ? { status: 304 }
          : { body: page('Dated') },
    });
    const first = await read(fake.request, { mode: 'page' });
    expect(first.outcomes[0]).toMatchObject({ kind: 'page', etag: '"v1"' });
    const again = await read(
      fake.request,
      { mode: 'page' },
      {
        known: (url) => (url === at('/') ? { etag: '"v1"', lastModified: null } : undefined),
      },
    );
    expect(again.outcomes).toEqual([{ kind: 'not_modified', url: at('/'), depth: 0 }]);
    const dated = await read(
      fake.request,
      { startUrl: at('/dated'), mode: 'page' },
      {
        known: () => ({ etag: null, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' }),
      },
    );
    expect(dated.outcomes[0]).toMatchObject({ kind: 'not_modified' });
  });

  it('tells a page that is gone from a page that failed, and treats a refusal as a failure', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(
          at('/'),
          at('/busy'),
          at('/gone'),
          at('/moved-on'),
          at('/broken'),
          at('/private'),
        ),
      },
      [at('/')]: { body: page('Home') },
      [at('/gone')]: { status: 404 },
      [at('/moved-on')]: { status: 410 },
      [at('/broken')]: { status: 500, body: 'secret stack trace' },
      [at('/private')]: { status: 403 },
      [at('/busy')]: { status: 429 },
    });
    const result = await read(fake.request);
    const kinds = Object.fromEntries(
      result.outcomes.map((o) => [o.url.replace(ORIGIN, ''), o.kind]),
    );
    expect(kinds).toMatchObject({
      '/gone': 'gone',
      '/moved-on': 'gone',
      '/broken': 'failed',
      '/private': 'failed',
      '/busy': 'failed',
    });
    // What a site says is never copied into a reason.
    expect(JSON.stringify(result.outcomes)).not.toContain('stack trace');
    // A site that is asked too often gets longer pauses.
    expect(result.sleeps.at(-1)).toBeGreaterThan(0);
  });

  it('backs off after a 429 and gives up when the site keeps failing', async () => {
    const routes: Record<string, Reply> = {
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(...Array.from({ length: 30 }, (_, i) => at(`/p${i}`))),
      },
    };
    for (let i = 0; i < 30; i += 1) routes[at(`/p${i}`)] = { status: 503 };
    const fake = site(routes);
    const result = await read(fake.request, {}, { delayMs: 100 });
    expect(result.report.stopped).toBe('trouble');
    expect(fake.urls().filter((url) => url.includes('/p')).length).toBeLessThan(15);
    // Every pause after a 503 doubles, up to a ceiling.
    const pauses = result.sleeps.filter((ms) => ms > 100);
    expect(pauses.length).toBeGreaterThan(1);
    expect(Math.max(...result.sleeps)).toBeLessThanOrEqual(10_000);
  });

  it('refuses a body that unpacks to too much, and a page that is too large', async () => {
    const bomb = gzipSync(Buffer.alloc(30 * 1024 * 1024));
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/bomb')]: { body: bomb, headers: { 'content-encoding': 'gzip' } },
      [at('/big')]: { body: Buffer.alloc(3 * 1024 * 1024, 97) },
    });
    const bombed = await read(fake.request, { startUrl: at('/bomb'), mode: 'page' });
    expect(bombed.outcomes).toMatchObject([{ kind: 'failed', reason: 'The page is too large.' }]);
    const big = await read(fake.request, { startUrl: at('/big'), mode: 'page' });
    expect(big.outcomes).toMatchObject([{ kind: 'failed', reason: 'The page is too large.' }]);
  });

  it('turns an egress refusal into words that never name the address', async () => {
    const refusing: RequestFn = async (url) => {
      if (url.endsWith('/robots.txt')) return made(404, {}, '');
      throw new EgressError('private_address', 'The address points to a private network.');
    };
    const result = await read(refusing, { mode: 'page' });
    expect(result.outcomes).toMatchObject([
      { kind: 'failed', reason: 'Hamnivo is not allowed to reach this address.' },
    ]);
  });

  it('stops when the time is up', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/'), at('/a'), at('/b'), at('/c')),
      },
      [at('/')]: { body: page('Home') },
      [at('/a')]: { body: page('A') },
      [at('/b')]: { body: page('B') },
      [at('/c')]: { body: page('C') },
    });
    let ticks = 0;
    const result = await read(fake.request, {}, { now: () => (ticks += 1), deadline: 3 });
    expect(result.report.stopped).toBe('time');
    expect(result.pages.length).toBeLessThan(4);
  });

  it('counts only the pages that were kept toward the limit', async () => {
    const fake = site({
      [at('/robots.txt')]: { status: 404 },
      [at('/sitemap.xml')]: {
        type: 'application/xml',
        body: urlset(at('/'), at('/empty'), at('/a'), at('/b')),
      },
      [at('/')]: { body: page('Home') },
      [at('/empty')]: { body: '<html><body></body></html>' },
      [at('/a')]: { body: page('A') },
      [at('/b')]: { body: page('B') },
    });
    const outcomes: PageOutcome[] = [];
    const result = await read(
      fake.request,
      { maxPages: 2 },
      {
        onOutcome: async (outcome) => {
          outcomes.push(outcome);
          return outcome.kind === 'page' && !outcome.url.endsWith('/empty');
        },
      },
    );
    expect(result.report.stopped).toBe('pages');
    expect(outcomes.filter((o) => o.kind === 'page').map((o) => o.url)).toEqual([
      at('/'),
      at('/empty'),
      at('/a'),
    ]);
  });
});
