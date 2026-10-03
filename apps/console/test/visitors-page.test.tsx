import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import {
  type LiveVisitor,
  type LiveVisitorList,
  type VisitorSettingsView,
  visitorKeys,
} from '../src/lib/visitors';
import { timeOnSite, VisitorsPage } from '../src/pages/visitors/VisitorsPage';
import { anchors, renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const NOW = '2026-10-03T10:30:00.000Z';

const visitor = (overrides: Partial<LiveVisitor> = {}): LiveVisitor => ({
  id: 'vis_1' as never,
  brand: { id: 'brd_1' as never, name: 'Noor Books' },
  name: 'Visitor 7K2F',
  identified: false,
  page: { url: 'https://noor.example/pricing?x=1', title: 'Pricing' },
  startedAt: '2026-10-03T10:23:00.000Z' as never,
  lastSeenAt: NOW as never,
  country: 'PK',
  device: { type: 'mobile', browser: 'Safari 17', os: 'iOS 17' },
  returning: false,
  visitCount: 1,
  referrer: null,
  conversationId: null,
  canInvite: true,
  ...overrides,
});

const list = (items: LiveVisitor[]): LiveVisitorList => ({
  items,
  generatedAt: NOW as never,
});

const show = (
  data: LiveVisitorList | null,
  permissions: readonly string[] = ['conversations.read', 'conversations.reply'],
  seed?: (client: QueryClient) => void,
) =>
  renderStudio({
    at: '/visitors',
    permissions,
    screen: (
      <AnnouncerProvider>
        <VisitorsPage />
      </AnnouncerProvider>
    ),
    seed: (client) => {
      if (data) client.setQueryData([TENANT_ID, ...visitorKeys.live('')], data);
      seed?.(client);
    },
  });

describe('live visitors', () => {
  const crowd = list([
    visitor(),
    visitor({
      id: 'vis_2' as never,
      name: 'Maya Khan',
      identified: true,
      page: { url: 'https://noor.example/contact', title: null },
      startedAt: '2026-10-03T09:10:00.000Z' as never,
      country: 'AE',
      device: { type: 'desktop', browser: 'Chrome 120', os: 'Windows 10' },
      returning: true,
      visitCount: 3,
      conversationId: 'conv_9' as never,
    }),
    visitor({
      id: 'vis_3' as never,
      name: 'Visitor 9QWA',
      startedAt: '2026-10-03T10:29:50.000Z' as never,
      country: null,
      canInvite: false,
    }),
  ]);

  it('names the page and says who is on the website now, and from when the list is', async () => {
    const html = await show(crowd);
    const text = textOf(html);
    expect(text).toContain('Live visitors');
    expect(text).toContain('People on your websites right now.');
    expect(text).toContain('On the website now: 3');
    expect(text).toMatch(/Updated \d{1,2}:\d{2}/);
    expect(html).toContain('<caption');
    for (const column of [
      'Visitor',
      'Page',
      'Time on site',
      'Country',
      'Device',
      'Visits',
      'Actions',
    ]) {
      expect(text, column).toContain(column);
    }
    // Reached from, and back to, the inbox.
    const back = anchors(html).find((link) => link.href === '/inbox');
    expect(back?.text).toContain('Back to inbox');
  });

  it('shows each visitor’s page, time, country, device and whether they came before', async () => {
    const html = await show(crowd);
    const rows = [...html.matchAll(/<tr[^>]*data-testid="visitor-row"[^>]*>([\s\S]*?)<\/tr>/g)].map(
      (match) => textOf(match[1] ?? ''),
    );
    expect(rows).toHaveLength(3);
    // A first-time visitor on a phone.
    expect(rows[0]).toContain('Visitor 7K2F');
    expect(rows[0]).toContain('Noor Books');
    expect(rows[0]).toContain('Pricing');
    expect(rows[0]).toContain('/pricing');
    expect(rows[0]).toContain('7 min');
    expect(rows[0]).toContain('Pakistan');
    expect(rows[0]).toContain('Phone · Safari 17 · iOS 17');
    expect(rows[0]).toContain('New');
    // A returning customer: their name, an hour and twenty minutes on the site, and the visit count.
    expect(rows[1]).toContain('Maya Khan');
    expect(rows[1]).toContain('/contact');
    expect(rows[1]).toContain('1 hr 20 min');
    expect(rows[1]).toContain('United Arab Emirates');
    expect(rows[1]).toContain('Computer · Chrome 120 · Windows 10');
    expect(rows[1]).toContain('Returning · 3');
    // Just arrived, country unknown.
    expect(rows[2]).toContain('Less than a minute');
    expect(rows[2]).toContain('—');
  });

  it('opens the chat a visitor is in, offers to start one for someone who can, and nothing otherwise', async () => {
    const html = await show(crowd);
    const links = anchors(html);
    expect(links.find((link) => link.href === '/inbox/conv_9')?.attrs['aria-label']).toBe(
      'Open the chat with Maya Khan',
    );
    expect(html).toContain('aria-label="Start a chat with Visitor 7K2F"');
    // Maya is already in a chat, and the third visitor's viewer may not start one.
    expect(html).not.toContain('aria-label="Start a chat with Maya Khan"');
    expect(html).not.toContain('aria-label="Start a chat with Visitor 9QWA"');
    expect(html.match(/data-testid="invite-visitor"/g)).toHaveLength(1);
  });

  it('opens a visitor’s page in a new tab, as the website’s own address', async () => {
    const pages = anchors(await show(crowd)).filter((link) =>
      link.href.startsWith('https://noor.example/'),
    );
    expect(pages.map((link) => link.href)).toEqual([
      'https://noor.example/pricing?x=1',
      'https://noor.example/contact',
      'https://noor.example/pricing?x=1',
    ]);
    for (const link of pages) expect(link.attrs.rel).toBe('noopener noreferrer');
  });

  it('says what to check when nobody is on the website', async () => {
    const text = textOf(await show(list([])));
    expect(text).toContain('Nobody is on your website right now');
    expect(text).toContain('page tracking turned on for the brand');
    expect(text).not.toContain('On the website now:');
  });

  it('is closed to someone who may not read conversations', async () => {
    const html = await show(null, ['agents.read']);
    expect(textOf(html)).toContain('Live visitors are not available to you');
    expect(html).not.toContain('visitors-table');
  });

  it('counts the time on the site up to the moment the list was made', () => {
    expect(timeOnSite(visitor(), NOW)).toBe(7 * 60);
    expect(timeOnSite(visitor({ startedAt: '2026-10-03T10:31:00.000Z' as never }), NOW)).toBe(0);
  });
});

describe('visitor tracking settings', () => {
  const brand = {
    id: 'brd_1',
    workspaceId: 'wsp_1',
    name: 'Noor Books',
    widgetId: 'wid_1',
    allowedOrigins: ['https://noor.example'],
    businessHours: null,
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  const settings = (tracking: boolean, keepQueryStrings: boolean): VisitorSettingsView => ({
    brandId: 'brd_1' as never,
    settings: { tracking, keepQueryStrings },
    updatedAt: null,
  });
  const withBrands = (view: VisitorSettingsView) => (client: QueryClient) => {
    client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
    client.setQueryData([TENANT_ID, ...visitorKeys.settings('brd_1')], view);
  };

  it('lets people who configure the widget choose, and says what is kept', async () => {
    const html = await show(
      single(),
      ['conversations.read', 'widget.configure', 'brands.manage'],
      withBrands(settings(true, false)),
    );
    const text = textOf(html);
    expect(text).toContain('Visitor tracking');
    expect(text).toContain('Note which pages visitors view');
    expect(text).toContain('Keep the part of a page address after the question mark');
    expect(text).toContain('30 days after the visitor was last seen');
    expect(text).toContain('No IP address is stored');
    // Tracking is on, queries are not kept, and nothing has changed to save yet.
    expect(tagWithId(html, 'visitor-tracking')).toContain('aria-checked="true"');
    expect(tagWithId(html, 'visitor-queries')).toContain('aria-checked="false"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled[^>]*>/);
  });

  it('shows tracking off, and then cannot keep query strings', async () => {
    const html = await show(
      single(),
      ['conversations.read', 'widget.configure', 'brands.manage'],
      withBrands(settings(false, false)),
    );
    expect(tagWithId(html, 'visitor-tracking')).toContain('aria-checked="false"');
    expect(tagWithId(html, 'visitor-queries')).toContain('disabled');
  });

  it('is not shown to people who may not configure the widget', async () => {
    const html = await show(
      single(),
      ['conversations.read', 'brands.manage'],
      withBrands(settings(true, false)),
    );
    expect(textOf(html)).not.toContain('Visitor tracking');
  });
});

/** The opening tag of the element with this id, whatever order its attributes come in. */
function tagWithId(html: string, id: string): string {
  return html.match(new RegExp(`<[^<>]*\\bid="${id}"[^<>]*>`))?.[0] ?? '';
}

function single() {
  return list([visitor()]);
}
