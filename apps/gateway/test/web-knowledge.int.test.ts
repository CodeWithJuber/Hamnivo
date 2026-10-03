import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import type { ResolvedAddress } from '@hamnivo/adapters/net';
import { dueWebSyncs, fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRAWLER_AGENT } from '../src/knowledge/web/robots.js';
import { WebSyncService } from '../src/knowledge/web/sync.service.js';
import { WebSyncWorker } from '../src/knowledge/web/worker.service.js';
import { tinyPdf } from './fixtures.js';
import { join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Websites as knowledge (G04, G17), from the address a person types to passages the AI cites: the
 * crawl reads a made-up site over loopback (trusted by the administrator, as the guard requires),
 * every page goes through the same ingestion as an upload, and a second read changes only what
 * changed. The made-up site is a real HTTP server, because the egress guard connects with its own
 * dispatcher, which an HTTP mock cannot intercept.
 */

interface Page {
  status?: number;
  type?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  etag?: string;
}

const html = (title: string, text: string, links: string[] = [], head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><nav>Menu</nav><h1>${title}</h1><p>${text}</p>${links
    .map((href) => `<a href="${href}">more</a>`)
    .join('')}<footer>Footer</footer></body></html>`;

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join('')}</urlset>`;

/** "سلام" in Windows-1256, under a page that declares it. */
const arabicPage = () =>
  Buffer.concat([
    Buffer.from('<html><head><meta charset="windows-1256"><title>Greeting</title></head><body><p>'),
    Buffer.from([0xd3, 0xe1, 0xc7, 0xe3]),
    Buffer.from('</p></body></html>'),
  ]);

let siteServer: Server;
let origin = '';
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const paths = () => seen.map((entry) => entry.path);
const site = {
  robots: { status: 200, body: '' } as { status: number; body: string },
  sitemap: [] as string[],
  pages: {} as Record<string, Page>,
};

/** Counts connections to an address the guard must never connect to. */
let sink: SocketServer;
let sinkPort = 0;
let sinkConnections = 0;
let rebindTo = '93.184.216.34';

const dns = async (host: string): Promise<ResolvedAddress[]> =>
  host === 'rebind.example.com'
    ? [{ address: rebindTo, family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const HOUR = 3_600_000;

let slice: Slice;
let shop: Shop;
let tenantId = '';
let worker: WebSyncWorker;
let service: WebSyncService;
let knowledgeSource = '';
let helpId = '';

const at = (path: string) => `${origin}${path}`;

function resetSite() {
  site.robots = {
    status: 200,
    body: ['User-agent: *', 'Disallow: /help/private/', `Sitemap: ${at('/sitemap.xml')}`].join(
      '\n',
    ),
  };
  site.sitemap = [
    at('/help/'),
    at('/help/returns'),
    at('/help/shipping'),
    at('/help/private/staff'),
    at('/help/guide.pdf'),
    at('/help/urdu'),
    'https://elsewhere.example/page',
  ];
  site.pages = {
    '/help/': {
      body: html(
        'Help centre',
        'Welcome to the help centre. Ask us anything.',
        [
          '/help/returns',
          '/help/shipping',
          '/help/old-page',
          '/help/jump',
          `http://127.0.0.1:${sinkPort}/`,
        ],
        '<link rel="canonical" href="/help/">',
      ),
    },
    '/help/returns': {
      body: html('Returns', 'You can return unworn items within thirty days of delivery.'),
    },
    '/help/shipping': {
      body: html('Shipping', 'We ship to Lahore, Karachi and Islamabad within three days.'),
      etag: '"ship-1"',
    },
    '/help/private/staff': {
      body: html('Staff', 'Internal staff only: the discount code is hush.'),
    },
    '/help/guide.pdf': {
      type: 'application/pdf',
      body: tinyPdf('Gift wrapping costs two hundred rupees.'),
    },
    '/help/urdu': { type: 'text/html; charset=windows-1256', body: arabicPage() },
    '/help/jump': { status: 302, headers: { location: `http://127.0.0.1:${sinkPort}/inside` } },
  };
}

beforeAll(async () => {
  sink = createSocketServer((socket) => {
    sinkConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  sinkPort = (sink.address() as AddressInfo).port;

  siteServer = createServer((request, response) => {
    const path = request.url ?? '/';
    seen.push({ path, headers: request.headers });
    request.resume();
    const send = (status: number, type: string, body: string | Buffer, extra = {}) =>
      response.writeHead(status, { 'content-type': type, ...extra }).end(body);
    if (path === '/robots.txt') {
      return send(site.robots.status, 'text/plain', site.robots.body);
    }
    if (path === '/sitemap.xml') {
      return site.sitemap.length > 0
        ? send(200, 'application/xml', urlset(...site.sitemap))
        : send(404, 'text/plain', 'none');
    }
    const page = site.pages[path.split('?')[0] ?? path];
    if (!page) return send(404, 'text/html', html('Not found', 'Nothing here.'));
    if (page.etag && request.headers['if-none-match'] === page.etag) {
      return response.writeHead(304, { etag: page.etag }).end();
    }
    return send(page.status ?? 200, page.type ?? 'text/html; charset=utf-8', page.body ?? '', {
      ...(page.etag ? { etag: page.etag } : {}),
      ...page.headers,
    });
  });
  await new Promise<void>((resolve) => siteServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
  resetSite();

  slice = await startSlice({
    clock,
    env: { EGRESS_TRUSTED_ORIGINS: origin, KNOWLEDGE_WEB_DELAY_MS: '0' },
    egressResolver: dns,
  });
  shop = await connectedTenant(slice, 'web');
  tenantId = fromPublicId('tenant', shop.tenantId);
  worker = slice.worker.get(WebSyncWorker);
  service = slice.worker.get(WebSyncService);
  // The worker is driven by hand in these tests.
  await worker.pause();
});

afterAll(async () => {
  await slice?.close();
  await new Promise((resolve) => siteServer?.close(resolve));
  await new Promise((resolve) => sink?.close(resolve));
});

async function webSources() {
  const listed = await shop.owner.get('/v1/admin/knowledge/web-sources');
  expect(listed.status).toBe(200);
  return listed.body.items as Record<string, any>[];
}

async function webSource(id: string) {
  const found = (await webSources()).find((entry) => entry.id === id);
  expect(found, id).toBeDefined();
  return found as Record<string, any>;
}

async function pagesOf(id: string) {
  const listed = await shop.owner.get(`/v1/admin/knowledge/web-sources/${id}/pages`);
  expect(listed.status).toBe(200);
  return listed.body.items as Record<string, any>[];
}

async function documentsOf(sourceId: string) {
  const listed = await shop.owner.get(`/v1/admin/knowledge/sources/${sourceId}/documents`);
  expect(listed.status).toBe(200);
  return listed.body.items as Record<string, any>[];
}

const documentAt = (documents: Record<string, any>[], path: string) =>
  documents.find((document) => document.url === at(path)) as Record<string, any>;

async function search(query: string) {
  const found = await shop.owner.post('/v1/admin/knowledge/search', {
    query,
    brandId: shop.brand.id,
    audience: 'customer',
  });
  expect(found.status).toBe(200);
  return found.body.items as Record<string, any>[];
}

/** Asks for a read now, lets the worker do it, and lets ingestion index what it found. */
async function readNow(id: string) {
  seen.length = 0;
  const queued = await shop.owner.post(`/v1/admin/knowledge/web-sources/${id}/sync`);
  expect(queued.status, JSON.stringify(queued.body)).toBe(202);
  expect(queued.body.state).toBe('queued');
  expect(await worker.drainOnce()).toBeGreaterThanOrEqual(1);
  await slice.drain();
  return webSource(id);
}

async function create(body: Record<string, unknown>) {
  const created = await shop.owner.post('/v1/admin/knowledge/web-sources', {
    brandId: shop.brand.id,
    ...body,
  });
  return created;
}

describe('adding a website', () => {
  it('reads robots.txt, the sitemap and the links, and makes each page a knowledge document', async () => {
    const created = await create({
      url: at('/help/'),
      mode: 'site',
      maxPages: 20,
      maxDepth: 2,
      schedule: 'weekly',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: '127.0.0.1',
      url: at('/help/'),
      mode: 'site',
      schedule: 'weekly',
      status: 'active',
      visibility: 'public',
      state: 'queued',
      lastRun: null,
      pageCount: 0,
    });
    helpId = created.body.id;
    knowledgeSource = created.body.sourceId;

    // Nothing is read until the worker gets to it; then robots.txt comes first.
    expect(seen).toEqual([]);
    expect(await worker.drainOnce()).toBe(1);
    expect(paths().slice(0, 2)).toEqual(['/robots.txt', '/sitemap.xml']);
    await slice.drain();

    const source = await webSource(helpId);
    expect(source).toMatchObject({
      state: 'idle',
      lastResult: 'succeeded',
      pageCount: 5,
    });
    expect(source.lastRun).toMatchObject({
      pages: 5,
      added: 5,
      updated: 0,
      unchanged: 0,
      retired: 0,
      truncated: false,
      robots: 'read',
      sitemaps: 1,
      problems: [],
    });
    // The page robots.txt disallows is left out, and so are the address that moved to another
    // origin and the link to a private one.
    expect(source.lastRun.skipped).toMatchObject({ robots: 1, offsite: 1 });
    const week = new Date(source.nextRunAt).getTime() - new Date(source.lastRunAt).getTime();
    expect(week).toBe(7 * 24 * HOUR);

    // Every request said who was asking, and the guard kept the reader on the site.
    expect(seen.every((entry) => entry.headers['user-agent'] === CRAWLER_AGENT)).toBe(true);
    expect(paths()).not.toContain('/help/private/staff');
    expect(sinkConnections).toBe(0);
    expect(paths()).not.toContain('/inside');
  });

  it('keeps each page as a document with its address, title and indexed passages', async () => {
    const documents = await documentsOf(knowledgeSource);
    expect(documents.map((document) => document.title).sort()).toEqual([
      'Greeting',
      'Help centre',
      'Returns',
      'Shipping',
      'guide',
    ]);
    for (const document of documents) {
      expect(document, document.url).toMatchObject({
        status: 'active',
        freshness: 'current',
        current: { version: 1, state: 'ready' },
      });
    }
    expect(documentAt(documents, '/help/guide.pdf').current.mediaType).toBe('application/pdf');
    expect(documentAt(documents, '/help/returns').current.mediaType).toBe('text/html');

    const pages = await pagesOf(helpId);
    expect(pages.map((entry) => [entry.url.replace(origin, ''), entry.state])).toEqual([
      ['/help/', 'ok'],
      ['/help/guide.pdf', 'ok'],
      ['/help/old-page', 'gone'],
      ['/help/returns', 'ok'],
      ['/help/shipping', 'ok'],
      ['/help/urdu', 'ok'],
    ]);
    expect(pages.find((entry) => entry.url === at('/help/returns'))).toMatchObject({
      status: 200,
      error: null,
      documentId: documentAt(documents, '/help/returns').id,
    });
  });

  it('answers customer questions from the pages, with the address as the citation', async () => {
    const returns = await search('return unworn items');
    expect(returns[0]).toMatchObject({ url: at('/help/returns'), title: 'Returns' });
    expect(returns[0]?.text).toContain('thirty days');
    // Navigation and footers are not part of what is learned.
    expect(returns[0]?.text).not.toContain('Menu');

    expect((await search('gift wrapping rupees'))[0]).toMatchObject({
      url: at('/help/guide.pdf'),
    });
    // A page in another character set is read as text.
    const versions = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.documentVersions),
    );
    expect(versions.some((version) => version.text?.includes('سلام'))).toBe(true);
    // What robots.txt keeps out is not in the knowledge.
    expect(
      (await search('discount code hush')).every((p) => p.url !== at('/help/private/staff')),
    ).toBe(true);
  });
});

describe('reading again', () => {
  it('adds a version only for pages that changed, retires pages that are gone and adds new ones', async () => {
    site.pages['/help/returns'] = {
      body: html('Returns', 'You can return unworn items within forty five days of delivery.'),
    };
    delete site.pages['/help/guide.pdf'];
    site.pages['/help/warranty'] = {
      body: html('Warranty', 'Every appliance has a two year warranty against defects.'),
    };
    site.sitemap = [...site.sitemap, at('/help/warranty')];

    const source = await readNow(helpId);
    expect(source).toMatchObject({ lastResult: 'succeeded', pageCount: 5 });
    expect(source.lastRun).toMatchObject({
      pages: 5,
      added: 1,
      updated: 1,
      unchanged: 3,
      retired: 1,
      problems: [],
    });
    // The page with an ETag was asked about conditionally and answered "not modified".
    const shipping = seen.find((entry) => entry.path === '/help/shipping');
    expect(shipping?.headers['if-none-match']).toBe('"ship-1"');

    const documents = await documentsOf(knowledgeSource);
    expect(documentAt(documents, '/help/returns')).toMatchObject({
      current: { version: 2, state: 'ready' },
    });
    expect(documentAt(documents, '/help/shipping').current.version).toBe(1);
    expect(documentAt(documents, '/help/').current.version).toBe(1);
    expect(documentAt(documents, '/help/urdu').current.version).toBe(1);
    expect(documentAt(documents, '/help/warranty').current.state).toBe('ready');
    expect(documentAt(documents, '/help/guide.pdf').status).toBe('retired');

    const pages = await pagesOf(helpId);
    expect(pages.find((entry) => entry.url === at('/help/guide.pdf'))).toMatchObject({
      state: 'gone',
      status: 404,
    });
  });

  it('answers from the new text and no longer from a page that is gone', async () => {
    const returns = await search('return unworn items');
    expect(returns[0]?.text).toContain('forty five days');
    expect(returns.every((passage) => !passage.text.includes('thirty days'))).toBe(true);
    expect(
      (await search('gift wrapping rupees')).every((p) => p.url !== at('/help/guide.pdf')),
    ).toBe(true);
    expect((await search('appliance warranty defects'))[0]).toMatchObject({
      url: at('/help/warranty'),
    });
  });

  it('retires pages that now ask not to be indexed', async () => {
    site.pages['/help/warranty'] = {
      body: html(
        'Warranty',
        'Every appliance has a two year warranty against defects.',
        [],
        '<meta name="robots" content="noindex">',
      ),
    };
    const source = await readNow(helpId);
    expect(source.lastRun).toMatchObject({ retired: 1, unchanged: 4 });
    expect(source.lastRun.skipped.noindex).toBe(1);
    expect(documentAt(await documentsOf(knowledgeSource), '/help/warranty').status).toBe('retired');
    site.pages['/help/warranty'] = {
      body: html('Warranty', 'Every appliance has a two year warranty against defects.'),
    };
  });

  it('stops using pages a site now asks readers to stay away from, and takes them back when it relents', async () => {
    site.robots = { status: 200, body: 'User-agent: HamnivoBot\nDisallow: /help/' };
    const closed = await readNow(helpId);
    expect(closed).toMatchObject({ lastResult: 'failed', pageCount: 0 });
    expect(closed.lastRun.problems[0]).toMatchObject({
      url: at('/help/'),
      reason: expect.stringContaining('robots.txt'),
    });
    // Nothing was requested but robots.txt and the sitemap it does not forbid.
    expect(paths()).toEqual(['/robots.txt', '/sitemap.xml']);
    const documents = await documentsOf(knowledgeSource);
    expect(documents.filter((document) => document.status === 'active')).toEqual([]);
    expect(await search('return unworn items')).toEqual([]);

    site.robots = { status: 200, body: `User-agent: *\nDisallow: /help/private/` };
    const reopened = await readNow(helpId);
    expect(reopened).toMatchObject({ lastResult: 'succeeded', pageCount: 5 });
    // The same text comes back without being indexed again.
    expect(reopened.lastRun).toMatchObject({ added: 0, updated: 5, retired: 0 });
    const back = await documentsOf(knowledgeSource);
    expect(documentAt(back, '/help/returns')).toMatchObject({
      status: 'active',
      current: { version: 2, state: 'ready' },
    });
    expect((await search('return unworn items'))[0]).toMatchObject({ url: at('/help/returns') });
  });

  it('does not forget what it learned because a site was down for a moment', async () => {
    site.robots = { status: 503, body: 'down' };
    const down = await readNow(helpId);
    expect(down).toMatchObject({ lastResult: 'failed', pageCount: 5 });
    expect(down.lastRun.robots).toBe('unreadable');
    expect(down.lastRun.problems[0].reason).toContain('could not be read');
    expect(paths()).toEqual(['/robots.txt']);

    site.robots = { status: 200, body: 'User-agent: *\nDisallow: /help/private/' };
    site.pages['/help/shipping'] = { status: 500, body: 'oops' };
    const partial = await readNow(helpId);
    expect(partial.lastResult).toBe('partial');
    expect(partial.lastRun.problems).toEqual([
      { url: at('/help/shipping'), reason: 'The site answered 500.' },
    ]);
    // A page that failed is kept as it was, and pages that were not met are not retired either.
    expect(partial.pageCount).toBe(5);
    expect(
      (await documentsOf(knowledgeSource)).filter((document) => document.status === 'active'),
    ).toHaveLength(5);
    expect(
      (await pagesOf(helpId)).find((entry) => entry.url === at('/help/shipping')),
    ).toMatchObject({
      state: 'failed',
      status: 500,
    });

    site.pages['/help/shipping'] = {
      body: html('Shipping', 'We ship to Lahore, Karachi and Islamabad within three days.'),
      etag: '"ship-1"',
    };
    expect((await readNow(helpId)).lastResult).toBe('succeeded');
  });

  it('keeps a document a person retired by hand retired', async () => {
    const documents = await documentsOf(knowledgeSource);
    const shipping = documentAt(documents, '/help/shipping');
    const retired = await shop.owner.post(`/v1/admin/knowledge/documents/${shipping.id}/retire`);
    expect(retired.status).toBe(200);
    const source = await readNow(helpId);
    expect(source.lastResult).toBe('succeeded');
    expect(documentAt(await documentsOf(knowledgeSource), '/help/shipping')).toMatchObject({
      status: 'retired',
      current: { version: 1 },
    });
    // It still counts as read, and it is not listed as gone.
    expect((await pagesOf(helpId)).find((entry) => entry.url === at('/help/shipping'))?.state).toBe(
      'ok',
    );
  });
});

describe('limits and schedules', () => {
  let docsId = '';

  it('keeps to the page limit and says the read was cut short', async () => {
    site.pages['/docs/'] = {
      body: html('Docs home', 'Documentation index.', ['/docs/a', '/docs/b', '/docs/c', '/docs/d']),
    };
    for (const name of ['a', 'b', 'c', 'd']) {
      site.pages[`/docs/${name}`] = {
        body: html(`Doc ${name}`, `Chapter ${name} covers topic ${name}.`),
      };
    }
    const created = await create({
      url: at('/docs/'),
      mode: 'site',
      maxPages: 2,
      maxDepth: 1,
      schedule: 'daily',
      name: 'Docs',
      visibility: 'internal',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Docs', visibility: 'internal', maxPages: 2 });
    docsId = created.body.id;
    expect(await worker.drainOnce()).toBe(1);
    await slice.drain();
    const source = await webSource(docsId);
    expect(source).toMatchObject({ lastResult: 'succeeded', pageCount: 2 });
    expect(source.lastRun).toMatchObject({ pages: 2, truncated: true, sitemaps: 1 });
    // An internal source answers staff, never customers.
    expect(
      (await search('Chapter a covers topic')).every((p) => !p.url.startsWith(at('/docs/'))),
    ).toBe(true);
    const staff = await shop.owner.post('/v1/admin/knowledge/search', {
      query: 'Chapter a covers topic',
      brandId: shop.brand.id,
      audience: 'staff',
    });
    expect(staff.body.items[0]).toMatchObject({ url: at('/docs/a') });
  });

  it('follows a change of limits: more pages when raised, pages past the limit retired when lowered', async () => {
    const raised = await shop.owner.patch(`/v1/admin/knowledge/web-sources/${docsId}`, {
      maxPages: 10,
    });
    expect(raised.status).toBe(200);
    expect(raised.body.maxPages).toBe(10);
    const wide = await readNow(docsId);
    expect(wide).toMatchObject({ pageCount: 5 });
    expect(wide.lastRun).toMatchObject({ added: 3, truncated: false });

    await shop.owner.patch(`/v1/admin/knowledge/web-sources/${docsId}`, { maxPages: 2 });
    const narrow = await readNow(docsId);
    expect(narrow).toMatchObject({ pageCount: 2, lastResult: 'succeeded' });
    expect(narrow.lastRun).toMatchObject({ truncated: true, retired: 3 });
    const gone = (await pagesOf(docsId)).filter((entry) => entry.state === 'gone');
    expect(gone).toHaveLength(3);
    expect(gone[0]?.error).toContain('past the limit');
  });

  it('reads on schedule, only when the time has come', async () => {
    expect(await worker.drainOnce()).toBe(0);
    const before = await webSource(docsId);
    expect(new Date(before.nextRunAt).getTime() - new Date(before.lastRunAt).getTime()).toBe(
      24 * HOUR,
    );
    offsetMs += 25 * HOUR;
    try {
      expect(await worker.drainOnce()).toBe(1);
      await slice.drain();
    } finally {
      offsetMs -= 25 * HOUR;
    }
    const after = await webSource(docsId);
    expect(after.lastRunAt).not.toBe(before.lastRunAt);
    expect(after.lastRun).toMatchObject({ added: 0, unchanged: 2 });
  });

  it('changes when a website is read again, and a manual website is read only on request', async () => {
    const manual = await shop.owner.patch(`/v1/admin/knowledge/web-sources/${docsId}`, {
      schedule: 'manual',
    });
    expect(manual.body).toMatchObject({ schedule: 'manual', nextRunAt: null });
    offsetMs += 60 * HOUR;
    try {
      expect(await worker.drainOnce()).toBe(0);
    } finally {
      offsetMs -= 60 * HOUR;
    }
    const weekly = await shop.owner.patch(`/v1/admin/knowledge/web-sources/${docsId}`, {
      schedule: 'weekly',
    });
    expect(weekly.body.schedule).toBe('weekly');
    // Read a moment ago, so the next read is a week after that one.
    expect(new Date(weekly.body.nextRunAt).getTime()).toBe(
      new Date(weekly.body.lastRunAt).getTime() + 7 * 24 * HOUR,
    );
    // Page mode reads only the address given.
    const page = await shop.owner.patch(`/v1/admin/knowledge/web-sources/${docsId}`, {
      mode: 'page',
    });
    expect(page.body.mode).toBe('page');
    const one = await readNow(docsId);
    expect(one.lastRun.pages).toBe(1);
    expect(paths()).toEqual(['/robots.txt', '/docs/']);
  });
});

describe('only one worker reads a website at a time', () => {
  it('lets one of two simultaneous reads through', async () => {
    const queued = await shop.owner.post(`/v1/admin/knowledge/web-sources/${helpId}/sync`);
    expect(queued.status).toBe(202);
    const [first, second] = await Promise.all([
      service.run(tenantId, fromPublicId('webSource', helpId)),
      service.run(tenantId, fromPublicId('webSource', helpId)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await slice.drain();
    expect((await webSource(helpId)).state).toBe('idle');
  });

  it('takes over a read a worker left unfinished, but not one that is alive', async () => {
    const id = fromPublicId('webSource', helpId);
    const hold = (state: 'running' | 'queued', leaseUntil: Date) =>
      withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .update(schema.knowledgeWebSources)
          .set({ state, leaseUntil })
          .where(eq(schema.knowledgeWebSources.id, id)),
      );
    // Alive: a lease that has not run out.
    await hold('running', new Date(Date.now() + 5 * 60_000));
    expect(await worker.drainOnce()).toBe(0);
    expect((await webSource(helpId)).state).toBe('running');
    // Left behind: the lease ran out.
    await hold('running', new Date(Date.now() - 1000));
    expect((await dueWebSyncs(slice.app, 10, clock())).some((due) => due.id === id)).toBe(true);
    expect(await worker.drainOnce()).toBe(1);
    await slice.drain();
    expect((await webSource(helpId)).state).toBe('idle');
  });

  it('does not read a website that was paused, and looks again tomorrow', async () => {
    const paused = await shop.owner.patch(`/v1/admin/knowledge/sources/${knowledgeSource}`, {
      status: 'paused',
    });
    expect(paused.status).toBe(200);
    const refused = await shop.owner.post(`/v1/admin/knowledge/web-sources/${helpId}/sync`);
    expect(refused.status).toBe(422);

    const id = fromPublicId('webSource', helpId);
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.knowledgeWebSources)
        .set({ state: 'queued', leaseUntil: new Date(Date.now() - 1000) })
        .where(eq(schema.knowledgeWebSources.id, id)),
    );
    seen.length = 0;
    expect(await worker.drainOnce()).toBe(0);
    expect(seen).toEqual([]);
    const source = await webSource(helpId);
    expect(source.state).toBe('idle');
    expect(new Date(source.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

    await shop.owner.patch(`/v1/admin/knowledge/sources/${knowledgeSource}`, { status: 'active' });
  });
});

describe('what is refused', () => {
  it('refuses addresses the egress guard does not allow, with words a person can act on', async () => {
    const refuse = async (url: string) => {
      const reply = await create({ url });
      expect(reply.status, url).toBe(422);
      return reply.body.fields?.[0] as { path: string; message: string };
    };
    expect(await refuse('http://news.example.com/')).toEqual({
      path: 'url',
      message: 'Use an https:// address.',
    });
    expect((await refuse('https://10.0.0.5/')).message).toContain('private or local network');
    expect((await refuse('https://intranet.local/')).message).toContain('private or local network');
    expect((await refuse(`http://127.0.0.1:${sinkPort}/`)).message).toContain('Use an https://');
    expect(
      ((await create({ url: 'ftp://files.example.com/' })).body.fields[0] as { path: string }).path,
    ).toBe('url');
    expect(sinkConnections).toBe(0);
    const again = await create({ url: at('/help/') });
    expect(again.status).toBe(422);
    expect(again.body.fields[0].message).toContain('already added');
  });

  it('refuses a site whose name turns private after it was added, without connecting', async () => {
    const created = await create({ url: `https://rebind.example.com:${sinkPort}/`, mode: 'page' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rebindTo = '127.0.0.1';
    try {
      expect(await worker.drainOnce()).toBe(1);
    } finally {
      rebindTo = '93.184.216.34';
    }
    const source = await webSource(created.body.id);
    expect(source).toMatchObject({ lastResult: 'failed', pageCount: 0 });
    expect(source.lastRun.problems[0].reason).toContain('Hamnivo is not allowed to reach');
    expect(sinkConnections).toBe(0);
  });

  it('refuses invalid limits and unknown websites', async () => {
    expect((await create({ url: at('/x/'), maxPages: 0 })).status).toBe(422);
    expect((await create({ url: at('/x/'), maxPages: 501 })).status).toBe(422);
    expect((await create({ url: at('/x/'), maxDepth: 6 })).status).toBe(422);
    expect((await create({ url: at('/x/'), schedule: 'hourly' })).status).toBe(422);
    expect((await create({ url: 'not a url' })).status).toBe(422);
    const patch = (body: object) =>
      shop.owner.patch(`/v1/admin/knowledge/web-sources/${helpId}`, body);
    expect((await patch({ maxPages: 1000 })).status).toBe(422);
    expect((await shop.owner.get('/v1/admin/knowledge/web-sources/wsrc_nope/pages')).status).toBe(
      404,
    );
    expect((await shop.owner.post('/v1/admin/knowledge/web-sources/wsrc_nope/sync')).status).toBe(
      404,
    );
  });

  it('lets an agent look but not change, and keeps one workspace out of another', async () => {
    const agent = await join(slice, shop, 'Wes Agent', 'agent');
    expect((await agent.client.get('/v1/admin/knowledge/web-sources')).status).toBe(200);
    expect((await agent.client.get(`/v1/admin/knowledge/web-sources/${helpId}/pages`)).status).toBe(
      200,
    );
    expect((await agent.client.post(`/v1/admin/knowledge/web-sources/${helpId}/sync`)).status).toBe(
      403,
    );
    expect(
      (await agent.client.patch(`/v1/admin/knowledge/web-sources/${helpId}`, { maxPages: 3 }))
        .status,
    ).toBe(403);
    expect(
      (
        await agent.client.post('/v1/admin/knowledge/web-sources', {
          brandId: shop.brand.id,
          url: at('/other/'),
        })
      ).status,
    ).toBe(403);

    const other = await connectedTenant(slice, 'web2');
    expect((await other.owner.get('/v1/admin/knowledge/web-sources')).body.items).toEqual([]);
    expect((await other.owner.get(`/v1/admin/knowledge/web-sources/${helpId}/pages`)).status).toBe(
      404,
    );
    expect((await other.owner.post(`/v1/admin/knowledge/web-sources/${helpId}/sync`)).status).toBe(
      404,
    );
    // Nor can it add a website to a brand that is not its own.
    const cross = await other.owner.post('/v1/admin/knowledge/web-sources', {
      brandId: shop.brand.id,
      url: at('/help/'),
    });
    expect([403, 404]).toContain(cross.status);
  });

  it('is idempotent when a person clicks twice', async () => {
    const body = { brandId: shop.brand.id, url: at('/idem/'), mode: 'page' };
    const headers = { 'idempotency-key': 'web-source-once' };
    const first = await shop.owner.post('/v1/admin/knowledge/web-sources', body, { headers });
    const second = await shop.owner.post('/v1/admin/knowledge/web-sources', body, { headers });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect((await webSources()).filter((entry) => entry.url === at('/idem/'))).toHaveLength(1);
  });
});

describe('the record', () => {
  it('audits every change and every read, without page content or addresses it read', async () => {
    const rows = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(like(schema.auditEvents.action, 'knowledge.web_%'))
        .orderBy(schema.auditEvents.seq),
    );
    const actions = new Set(rows.map((row) => row.action));
    expect(actions).toEqual(
      new Set([
        'knowledge.web_source_added',
        'knowledge.web_source_updated',
        'knowledge.web_sync_requested',
        'knowledge.web_synced',
      ]),
    );
    const reads = rows.filter((row) => row.action === 'knowledge.web_synced');
    expect(reads.length).toBeGreaterThan(8);
    expect(reads.every((row) => row.actorType === 'system')).toBe(true);
    expect(reads[0]?.data).toMatchObject({ result: 'succeeded', pages: 5, added: 5 });
    const text = JSON.stringify(rows.map((row) => row.data));
    for (const secret of ['unworn', 'Lahore', 'warranty', 'hush']) {
      expect(text).not.toContain(secret);
    }
  });
});
