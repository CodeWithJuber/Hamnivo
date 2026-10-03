import { presetPermissions } from '@hamnivo/policy';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';
import { initI18n } from '../src/i18n';
import { anchors, current, navigation, renderStudio } from './render';

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
const AI_PAGES = [
  '/agents',
  '/knowledge',
  '/memory',
  '/tools',
  '/checks',
  '/decisions',
  '/runs',
  '/caching',
  '/models',
];

describe('the menu', () => {
  it('has six entries, each opening the first page its person can see', async () => {
    const menu = navigation(await shell('/overview', owner), 'Studio');
    expect(menu?.map((link) => [link.text, link.href])).toEqual([
      ['Home', '/overview'],
      ['Inbox', '/inbox'],
      ['AI assistant', '/agents'],
      ['Sales', '/orders'],
      ['Reports', '/reports'],
      ['Settings', '/brands'],
    ]);
  });

  it('shows an entry only when a page in it can be seen', async () => {
    const menu = navigation(await shell('/overview', presetPermissions('agent')), 'Studio');
    // A support agent: no AI agents, memory or reports, so the AI entry opens Knowledge.
    expect(menu?.map((link) => [link.text, link.href])).toEqual([
      ['Home', '/overview'],
      ['Inbox', '/inbox'],
      ['AI assistant', '/knowledge'],
      ['Sales', '/orders'],
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
    expect(await active('/orders/ord_1')).toEqual(['/orders']);
    expect(await active('/finance')).toEqual(['/orders']);
    expect(await active('/reports')).toEqual(['/reports']);
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
      'Knowledge',
      'Customer memory',
    ]);
    expect(current(tabs)).toEqual(['/agents']);
    // It sits inside the page area, above the page.
    expect(html.indexOf('data-testid="section-tabs"')).toBeLessThan(html.indexOf('The page'));
  });

  it('follows the page, nested ones included', async () => {
    const orders = navigation(await shell('/orders/ord_1', owner), 'Sales pages');
    expect(orders?.map((link) => link.href)).toEqual(['/orders', '/finance']);
    expect(current(orders)).toEqual(['/orders']);
    const settings = navigation(await shell('/security', owner), 'Settings pages');
    expect(settings?.map((link) => link.href)).toEqual([
      '/brands',
      '/team',
      '/security',
      '/developer',
      '/migration',
    ]);
    expect(current(settings)).toEqual(['/security']);
  });

  it('lists only the pages the person can see, and marks none on a page that is not theirs', async () => {
    const tabs = navigation(
      await shell('/memory', presetPermissions('agent')),
      'AI assistant pages',
    );
    expect(tabs?.map((link) => link.href)).toEqual(['/knowledge', '/tools', '/caching']);
    expect(current(tabs)).toEqual([]);
  });

  it('is left out where there is nothing to choose between', async () => {
    const rows = (html: string) => html.includes('data-testid="section-tabs"');
    // Home, the inbox and reports are single pages.
    expect(rows(await shell('/overview', owner))).toBe(false);
    expect(rows(await shell('/inbox', owner))).toBe(false);
    expect(rows(await shell('/reports', owner))).toBe(false);
    // Pages outside the menu.
    expect(rows(await shell('/stop-ai', owner))).toBe(false);
    expect(rows(await shell('/account', owner))).toBe(false);
    // One page of an entry: finance sees Activity and nothing else of the AI assistant.
    expect(rows(await shell('/runs', presetPermissions('finance')))).toBe(false);
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
    expect(menu?.length).toBe(6);
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
