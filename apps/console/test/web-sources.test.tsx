import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { beforeAll, describe, expect, it } from 'vitest';
import { WebSourceLine, WebSourcePanel } from '../src/components/knowledge/WebSourcePanel';
import { initI18n } from '../src/i18n';
import type { KnowledgeWebSource } from '../src/lib/ai-power';
import { renderStudio, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const run = {
  startedAt: '2026-10-02T09:00:00.000Z',
  finishedAt: '2026-10-02T09:02:00.000Z',
  pages: 12,
  added: 3,
  updated: 2,
  unchanged: 7,
  retired: 1,
  skipped: { robots: 2, offsite: 0, noindex: 1, type: 0, duplicate: 0, empty: 0 },
  problems: [
    { url: 'https://example.com/help/broken', reason: 'The site answered 500.' },
    { url: 'https://example.com/help/slow', reason: 'The site did not answer in time.' },
  ],
  truncated: true,
  robots: 'read' as const,
  sitemaps: 1,
};

const website: KnowledgeWebSource = {
  id: 'wsrc_1',
  sourceId: 'ksrc_1',
  brandId: 'brd_1',
  name: 'example.com',
  visibility: 'public',
  status: 'active',
  url: 'https://example.com/help/',
  mode: 'site',
  maxPages: 50,
  maxDepth: 2,
  schedule: 'weekly',
  state: 'idle',
  nextRunAt: '2026-10-09T09:02:00.000Z',
  lastRunAt: '2026-10-02T09:02:00.000Z',
  lastResult: 'partial',
  lastRun: run,
  pageCount: 12,
  createdAt: '2026-10-01T09:00:00.000Z',
};

const panel = (web: KnowledgeWebSource, permissions: readonly string[]) =>
  renderStudio({
    at: '/knowledge',
    permissions,
    screen: (
      <AnnouncerProvider>
        <WebSourcePanel web={web} onSettings={() => undefined} />
      </AnnouncerProvider>
    ),
  });

const MANAGER = ['knowledge.read', 'knowledge.manage'];

describe('the website behind a knowledge source', () => {
  it('shows where it starts, how far it reads, how often, and how the last read went', async () => {
    const html = await panel(website, MANAGER);
    const text = textOf(html);
    expect(text).toContain('https://example.com/help/');
    expect(text).toContain('The whole site: up to 50 pages, 2 links deep');
    expect(text).toContain('Every week');
    expect(text).toContain('Pages kept 12');
    expect(text).toContain('Read, with problems');
    expect(html).toContain('data-state="partial"');
  });

  it('opens the website in a new tab without handing the page over', async () => {
    const html = await panel(website, MANAGER);
    const link = html.match(/<a\b[^>]*href="https:\/\/example\.com\/help\/"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noreferrer noopener"');
  });

  it('lists what the last read did: counts, what was left out and why pages failed', async () => {
    const text = textOf(await panel(website, MANAGER));
    for (const line of [
      'New: 3',
      'Changed: 2',
      'Unchanged: 7',
      'Removed: 1',
      'Sitemaps read: 1',
      'The site asks readers to stay away (robots.txt): 2',
      'Pages that ask not to be indexed: 1',
      'https://example.com/help/broken',
      'The site answered 500.',
      'The site did not answer in time.',
      'The read stopped before it reached every page',
      'The site’s robots.txt was read and followed.',
    ]) {
      expect(text, line).toContain(line);
    }
    // What was not left out is not listed.
    expect(text).not.toContain('On another site');
  });

  it('offers to read now and to change settings only to people who can manage knowledge', async () => {
    const manager = await panel(website, MANAGER);
    expect(manager).toContain('aria-label="Read example.com now"');
    expect(manager).toContain('aria-label="Settings for example.com"');
    expect(textOf(manager)).toContain('See pages');
    const reader = await panel(website, ['knowledge.read']);
    expect(reader).not.toContain('Read example.com now');
    expect(reader).not.toContain('Settings for example.com');
    expect(textOf(reader)).toContain('See pages');
  });

  it('says so while a read is waiting or going, and does not offer another', async () => {
    for (const [state, words] of [
      ['queued', 'Waiting to be read'],
      ['running', 'Reading now'],
    ] as const) {
      const html = await panel({ ...website, state }, MANAGER);
      expect(textOf(html), state).toContain(words);
      expect(html).toContain(`data-state="${state}"`);
      expect(html).toContain('role="status"');
      const button =
        html.match(/<button\b[^>]*aria-label="Read example\.com now"[^>]*>/)?.[0] ?? '';
      expect(button, state).toContain('disabled');
    }
  });

  it('tells a website that has never been read from one that failed', async () => {
    const never = await panel(
      { ...website, lastRun: null, lastRunAt: null, lastResult: null, nextRunAt: null },
      MANAGER,
    );
    expect(textOf(never)).toContain('This website has not been read yet.');
    expect(never).toContain('data-state="never"');
    expect(never).not.toContain('data-testid="web-last-run"');

    const failed = await panel(
      {
        ...website,
        lastResult: 'failed',
        lastRun: {
          ...run,
          pages: 0,
          truncated: false,
          robots: 'unreadable',
          problems: [
            {
              url: 'https://example.com/help/',
              reason: 'The site’s robots.txt could not be read, so nothing was read.',
            },
          ],
        },
      },
      MANAGER,
    );
    expect(failed).toContain('data-state="failed"');
    expect(textOf(failed)).toContain('Could not be read');
    expect(textOf(failed)).toContain(
      'The site’s robots.txt could not be read, so nothing was read.',
    );
  });

  it('shows a page-only website and a manual schedule plainly', async () => {
    const text = textOf(
      await panel({ ...website, mode: 'page', schedule: 'manual', nextRunAt: null }, MANAGER),
    );
    expect(text).toContain('This page only');
    expect(text).toContain('Only when I ask');
    expect(text).not.toContain('Next read');
  });

  it('keeps what a site says about itself quoted and in its own direction', async () => {
    const html = await panel(
      {
        ...website,
        lastRun: {
          ...run,
          problems: [{ url: 'https://example.com/ar', reason: '<img src=x onerror=alert(1)>' }],
        },
      },
      MANAGER,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toMatch(/<bdi dir="ltr"[^>]*>https:\/\/example\.com\/ar<\/bdi>/);
  });
});

describe('a website in the list of sources', () => {
  const line = async (web: KnowledgeWebSource) =>
    textOf(
      await renderStudio({
        at: '/knowledge',
        permissions: ['knowledge.read'],
        screen: <WebSourceLine web={web} />,
      }),
    );

  it('says it is a website and how its reading stands', async () => {
    expect(await line({ ...website, state: 'running' })).toBe('Website · Reading now');
    expect(await line({ ...website, state: 'queued' })).toBe('Website · Waiting to be read');
    expect(await line({ ...website, lastRunAt: null })).toBe('Website · Not read yet');
    expect(await line(website)).toMatch(/^Website · Read /);
  });
});
