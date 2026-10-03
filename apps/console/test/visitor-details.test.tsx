import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { type ConversationVisitor, visitorKeys } from '../src/lib/visitors';
import { VisitorDetails } from '../src/pages/inbox/VisitorDetails';
import { anchors, renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const CHAT = 'conv_1';

const card: NonNullable<ConversationVisitor['visitor']> = {
  id: 'vis_1' as never,
  firstSeenAt: '2026-10-03T09:00:00.000Z' as never,
  lastSeenAt: new Date().toISOString() as never,
  visitCount: 3,
  returning: true,
  online: true,
  country: 'PK',
  device: { type: 'mobile', browser: 'Safari 17', os: 'iOS 17' },
  language: 'en',
  referrer: 'https://www.google.com/search',
  entryUrl: 'https://noor.example/pricing',
  currentPage: { url: 'https://noor.example/contact', title: 'Contact us' },
  visitStartedAt: '2026-10-03T10:00:00.000Z' as never,
  timeOnSiteSeconds: 7 * 60 + 12,
  pages: [
    {
      url: 'https://noor.example/contact',
      title: 'Contact us',
      viewedAt: '2026-10-03T10:06:00.000Z' as never,
    },
    {
      url: 'https://noor.example/pricing',
      title: null,
      viewedAt: '2026-10-03T10:00:00.000Z' as never,
    },
  ],
};

const show = (value: ConversationVisitor) =>
  renderStudio({
    at: '/inbox',
    permissions: ['conversations.read'],
    screen: (
      <AnnouncerProvider>
        <VisitorDetails conversationId={CHAT} />
      </AnnouncerProvider>
    ),
    seed: (client: QueryClient) =>
      client.setQueryData([TENANT_ID, ...visitorKeys.conversation(CHAT)], value),
  });

describe('the visitor beside a conversation', () => {
  it('shows where the visitor is, for how long, from where, and on what', async () => {
    const html = await show({ tracking: true, visitor: card });
    const text = textOf(html);
    expect(text).toContain('On the website now');
    for (const expected of [
      'Current page',
      'Contact us',
      '/contact',
      'Visits 3',
      'Returning',
      '7 min',
      'Pakistan',
      'Phone · Safari 17 · iOS 17',
      'English',
      'www.google.com/search',
      'Pages in this visit',
    ]) {
      expect(text, expected).toContain(expected);
    }
    // The list of pages, newest first, with a name for a page without a title.
    const pages = html.match(/data-testid="visitor-pages"[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? '';
    expect(textOf(pages)).toMatch(/Contact us.*\/contact.*Untitled page.*\/pricing/);
    // The privacy note says what is kept.
    expect(text).toContain('No IP address is stored');
  });

  it('opens the visitor’s own pages in a new tab, and gives each link a name', async () => {
    const links = anchors(await show({ tracking: true, visitor: card })).filter((link) =>
      link.href.startsWith('https://noor.example/'),
    );
    expect(links.map((link) => link.href)).toEqual([
      'https://noor.example/contact',
      'https://noor.example/contact',
      'https://noor.example/pricing',
    ]);
    for (const link of links) {
      expect(link.attrs.target).toBe('_blank');
      expect(link.attrs.rel).toBe('noopener noreferrer');
      expect(link.attrs['aria-label']).toMatch(/^Open .+ in a new tab$/);
    }
  });

  it('says a first-time visitor is new, and when the visitor has left', async () => {
    const left = await show({
      tracking: true,
      visitor: {
        ...card,
        online: false,
        returning: false,
        visitCount: 1,
        timeOnSiteSeconds: 20,
        country: null,
        referrer: null,
        language: null,
        lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() as never,
      },
    });
    const text = textOf(left);
    expect(text).toContain('Left the website 10 minutes ago');
    expect(text).not.toContain('On the website now');
    expect(text).toContain('Visitor New');
    expect(text).toContain('Less than a minute');
    // Rows with nothing to show are not shown.
    expect(text).not.toContain('Country');
    expect(text).not.toContain('Came from');
    expect(text).not.toContain('Language');
  });

  it('says why there is nothing to show', async () => {
    expect(textOf(await show({ tracking: true, visitor: null }))).toContain(
      'No pages are noted for this customer.',
    );
    expect(textOf(await show({ tracking: false, visitor: null }))).toContain(
      'This brand does not note which pages visitors view.',
    );
  });
});
