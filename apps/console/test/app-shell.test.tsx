import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';
import { initI18n } from '../src/i18n';
import { anchors, current, navigation, renderStudio, TENANT_ID } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const shell = (at: string, permissions: readonly string[]) =>
  renderStudio({
    at,
    permissions,
    screen: (
      <AppShell>
        <p>The page</p>
      </AppShell>
    ),
  });

const owner = presetPermissions('owner');
// Frozen pages (decisions, checks, workflows) are left out: the server's default.
const AI_PAGES = [
  '/agents',
  '/memory',
  '/connectors',
  '/automations',
  '/tools',
  '/models',
  '/runs',
];

describe('the menu', () => {
  it('has five entries, each opening the first page its person can see', async () => {
    const menu = navigation(await shell('/overview', owner), 'Studio');
    expect(menu?.map((link) => [link.text, link.href])).toEqual([
      ['Home', '/overview'],
      ['Inbox', '/inbox'],
      ['AI assistant', '/agents'],
      ['Knowledge', '/knowledge'],
      ['Settings', '/brands'],
    ]);
  });

  it('shows an entry only when a page in it can be seen', async () => {
    const menu = navigation(await shell('/overview', presetPermissions('agent')), 'Studio');
    // A support agent: no AI agents, memory or reports, so the AI entry opens Connectors; orders
    // are frozen, so Settings opens the team.
    expect(menu?.map((link) => [link.text, link.href])).toEqual([
      ['Home', '/overview'],
      ['Inbox', '/inbox'],
      ['AI assistant', '/connectors'],
      ['Knowledge', '/knowledge'],
      ['Settings', '/team'],
    ]);
    const nothing = navigation(await shell('/overview', ['conversations.read']), 'Studio');
    expect(nothing?.map((link) => link.text)).toEqual(['Home', 'Inbox']);
  });

  it('is active on every page of its entry, nested pages included', async () => {
    const active = async (at: string) => current(navigation(await shell(at, owner), 'Studio'));
    expect(await active('/overview')).toEqual(['/overview']);
    expect(await active('/inbox/conv_1')).toEqual(['/inbox']);
    expect(await active('/agents/agt_1')).toEqual(['/agents']);
    expect(await active('/memory/cus_1')).toEqual(['/agents']);
    expect(await active('/models')).toEqual(['/agents']);
    expect(await active('/connectors')).toEqual(['/agents']);
    expect(await active('/knowledge')).toEqual(['/knowledge']);
    expect(await active('/caching')).toEqual(['/knowledge']);
    // Frozen pages opened by address still mark their entry.
    expect(await active('/orders/ord_1')).toEqual(['/brands']);
    expect(await active('/finance')).toEqual(['/brands']);
    expect(await active('/decisions')).toEqual(['/agents']);
    expect(await active('/reports')).toEqual(['/overview']);
    expect(await active('/channels')).toEqual(['/brands']);
    expect(await active('/developer')).toEqual(['/brands']);
    // Pages that are not in the menu leave it with nothing marked.
    expect(await active('/stop-ai')).toEqual([]);
    expect(await active('/account')).toEqual([]);
  });

  it('keeps Account security in the account menu', async () => {
    const html = await shell('/overview', owner);
    const links = anchors(html);
    expect(links.find((link) => link.href === '/account')?.text).toBe('Account security');
    expect(navigation(html, 'Studio')?.some((link) => link.href === '/account')).toBe(false);
  });
});

describe('the row of pages above a page', () => {
  it('lists the pages of the current entry, with the current one marked', async () => {
    const html = await shell('/agents/agt_1', owner);
    const tabs = navigation(html, 'AI assistant pages');
    expect(tabs?.map((link) => link.href)).toEqual(AI_PAGES);
    expect(tabs?.slice(0, 3).map((link) => link.text)).toEqual([
      'AI agents',
      'Customer memory',
      'Connectors',
    ]);
    expect(current(tabs)).toEqual(['/agents']);
    // It sits inside the page area, above the page.
    expect(html.indexOf('data-testid="section-tabs"')).toBeLessThan(html.indexOf('The page'));
  });

  it('follows the page, nested ones included', async () => {
    const memory = navigation(await shell('/memory/cus_1', owner), 'AI assistant pages');
    expect(current(memory)).toEqual(['/memory']);
    // A frozen page opened by address keeps its entry's row, without itself in it.
    const orders = navigation(await shell('/orders/ord_1', owner), 'Settings pages');
    expect(orders?.map((link) => link.href)).not.toContain('/orders');
    expect(current(orders)).toEqual([]);
    const settings = navigation(await shell('/security', owner), 'Settings pages');
    expect(settings?.map((link) => link.href)).toEqual(
      expect.arrayContaining([
        '/brands',
        '/branding',
        '/chat-widget',
        '/channels',
        '/hours',
        '/team',
        '/security',
        '/settings/billing',
        '/settings/privacy',
      ]),
    );
    expect(current(settings)).toEqual(['/security']);
  });

  it('lists only the pages the person can see, and marks none on a page that is not theirs', async () => {
    const tabs = navigation(
      await shell('/memory', presetPermissions('agent')),
      'AI assistant pages',
    );
    expect(tabs?.map((link) => link.href)).toEqual(['/connectors', '/tools']);
    expect(current(tabs)).toEqual([]);
  });

  it('is left out where there is nothing to choose between', async () => {
    const rows = (html: string) => html.includes('data-testid="section-tabs"');
    // The inbox is a single page; Home is one for whoever cannot read reports.
    expect(rows(await shell('/inbox', owner))).toBe(false);
    expect(rows(await shell('/overview', ['conversations.read']))).toBe(false);
    expect(rows(await shell('/overview', owner))).toBe(true);
    expect(rows(await shell('/reports', owner))).toBe(true);
    // Pages outside the menu.
    expect(rows(await shell('/stop-ai', owner))).toBe(false);
    expect(rows(await shell('/account', owner))).toBe(false);
    // One page of an entry: finance sees Activity and nothing else of the AI assistant.
    expect(rows(await shell('/runs', presetPermissions('finance')))).toBe(false);
  });
});

describe('frozen features', () => {
  const at = (path: string, advanced: boolean, seed?: (client: QueryClient) => void) =>
    renderStudio({
      at: path,
      permissions: [...owner, 'agency.read'],
      advanced,
      ...(seed ? { seed } : {}),
      screen: (
        <AppShell>
          <p>The page</p>
        </AppShell>
      ),
    });
  const testIds = (html: string) => anchors(html).map((link) => link.attrs['data-testid']);

  it('are listed in their entry only when the server turns advanced features on', async () => {
    const off = navigation(await at('/agents', false), 'AI assistant pages');
    const on = navigation(await at('/agents', true), 'AI assistant pages');
    for (const path of ['/workflows', '/checks', '/decisions']) {
      expect(off?.map((link) => link.href)).not.toContain(path);
      expect(on?.map((link) => link.href)).toContain(path);
    }
    const settings = navigation(await at('/brands', true), 'Settings pages');
    expect(settings?.map((link) => link.href)).toEqual(
      expect.arrayContaining(['/orders', '/finance', '/migration']),
    );
  });

  it('keep the platform console link for operators only when they are on', async () => {
    const operator = (client: QueryClient) =>
      client.setQueryData(['platform', 'me'], { operator: true });
    expect(testIds(await at('/overview', false, operator))).not.toContain('platform-link');
    expect(testIds(await at('/overview', true, operator))).toContain('platform-link');
    // Someone who is not an operator never sees it.
    expect(testIds(await at('/overview', true))).not.toContain('platform-link');
  });

  it('keep the agency link out of the header unless they are on', async () => {
    const agency = (client: QueryClient) =>
      client.setQueryData([TENANT_ID, 'agency'], {
        enabled: true,
        branding: { displayName: null, accentColor: null },
        clientLimit: null,
      });
    expect(testIds(await at('/overview', false, agency))).not.toContain('agency-context');
    expect(testIds(await at('/overview', true, agency))).toContain('agency-context');
  });
});

describe('Stop AI', () => {
  const stopAi = async (at: string, permissions: readonly string[]) => {
    const html = await shell(at, permissions);
    return {
      button: anchors(html).find((link) => link.attrs['data-testid'] === 'stop-ai-button'),
      menu: navigation(html, 'Studio'),
    };
  };

  it('is a danger button in the header that links to the Stop AI page, not an entry in the menu', async () => {
    const { button, menu } = await stopAi('/overview', owner);
    expect(button?.href).toBe('/stop-ai');
    expect(button?.text).toBe('Stop AI');
    expect(button?.attrs['aria-label']).toBe('Stop AI replies');
    expect(button?.attrs.class).toContain('bg-danger');
    expect(menu?.some((link) => link.href === '/stop-ai')).toBe(false);
    expect(menu?.length).toBe(5);
  });

  it('is shown only to people who can stop the AI', async () => {
    expect((await stopAi('/overview', ['agents.read', 'agents.publish'])).button).toBeDefined();
    // Seeing the AI's settings is not enough: the page would be read-only for them.
    expect((await stopAi('/overview', ['agents.read'])).button).toBeUndefined();
  });

  it('is marked as the current page on the Stop AI page', async () => {
    const { button } = await stopAi('/stop-ai', owner);
    expect(button?.attrs['aria-current']).toBe('page');
  });
});

describe('Search', () => {
  it('is a button in the header for everyone, named for what it does, with its shortcut', async () => {
    for (const permissions of [owner, presetPermissions('agent'), []]) {
      const html = await shell('/overview', permissions);
      const button = html.match(/<button[^>]*data-testid="palette-button"[^>]*>/)?.[0] ?? '';
      expect(button).toContain('aria-label="Search pages"');
      expect(button).toContain('aria-keyshortcuts="Meta+K Control+K"');
      expect(button).toContain('aria-haspopup="dialog"');
    }
  });
});
