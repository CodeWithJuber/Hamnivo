import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { presetPermissions } from '@hamnivo/policy';
import { describe, expect, it } from 'vitest';
import {
  currentRoute,
  groupIdOfPath,
  isOnRoute,
  menuFor,
  NAV_GROUPS,
  type NavGroupId,
  sectionOf,
} from '../src/lib/nav';

const holding = (...permissions: string[]) => {
  const held = new Set(permissions);
  return (permission: string) => held.has(permission);
};
const role = (key: Parameters<typeof presetPermissions>[0]) => holding(...presetPermissions(key));
const entries = (can: (permission: string) => boolean) =>
  menuFor(can).map((group) => [group.id, group.to]);

describe('the menu', () => {
  it('has six entries, in this order', () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual([
      'home',
      'inbox',
      'ai',
      'sales',
      'reports',
      'settings',
    ]);
  });

  it('keeps the pages of each entry in their order', () => {
    const pages = Object.fromEntries(
      NAV_GROUPS.map((group) => [group.id, group.routes.map((route) => route.to)]),
    );
    expect(pages).toEqual({
      home: ['/overview'],
      inbox: ['/inbox'],
      ai: [
        '/agents',
        '/knowledge',
        '/memory',
        '/tools',
        '/checks',
        '/decisions',
        '/runs',
        '/caching',
        '/models',
      ],
      sales: ['/orders', '/finance'],
      reports: ['/reports'],
      settings: ['/brands', '/team', '/security', '/developer', '/migration', '/settings/billing'],
    });
  });

  it('keeps the permission each page had in the flat list', () => {
    const permissions = Object.fromEntries(
      NAV_GROUPS.flatMap((group) =>
        group.routes.map((route) => [route.to, route.permission ?? route.anyOf ?? null]),
      ),
    );
    expect(permissions).toEqual({
      '/overview': null,
      '/inbox': 'conversations.read',
      '/agents': 'agents.read',
      '/knowledge': 'knowledge.read',
      '/memory': 'memory.read',
      '/tools': 'tools.read',
      '/checks': 'decisions.read',
      '/decisions': 'decisions.read',
      '/runs': 'analytics.read',
      '/caching': 'knowledge.read',
      '/models': 'integrations.manage',
      '/orders': 'commerce.read',
      '/finance': 'commerce.read',
      '/reports': ['analytics.read', 'billing.read'],
      '/brands': 'brands.manage',
      '/team': 'members.read',
      '/security': ['security.manage', 'support.grant'],
      '/developer': ['api_keys.read', 'webhooks.read', 'network.manage'],
      '/migration': 'migration.review',
      '/settings/billing': ['billing.read', 'settings.manage'],
    });
  });

  it('gives every Studio page a place, except the two that live elsewhere', () => {
    const folder = fileURLToPath(new URL('../src/routes/_studio', import.meta.url));
    const pages = new Set(
      readdirSync(folder, { withFileTypes: true }).map(
        (entry) => `/${entry.name.replace(/\.tsx$/, '').replaceAll('.', '/')}`,
      ),
    );
    // Stop AI is a button in the header; Account security is in the account menu.
    const elsewhere = ['/stop-ai', '/account'];
    const placed = NAV_GROUPS.flatMap((group) => group.routes.map((route) => route.to));
    expect([...pages].filter((page) => !elsewhere.includes(page)).sort()).toEqual(
      [...placed].sort(),
    );
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe('who sees which entry', () => {
  it('shows Home to everyone, and nothing else to someone with no permissions', () => {
    expect(entries(holding())).toEqual([['home', '/overview']]);
  });

  it('shows all six entries to the owner, each opening its first page', () => {
    expect(entries(role('owner'))).toEqual([
      ['home', '/overview'],
      ['inbox', '/inbox'],
      ['ai', '/agents'],
      ['sales', '/orders'],
      ['reports', '/reports'],
      ['settings', '/brands'],
    ]);
  });

  it('shows an entry only when one of its pages can be seen', () => {
    expect(entries(holding('conversations.read'))).toEqual([
      ['home', '/overview'],
      ['inbox', '/inbox'],
    ]);
    expect(entries(holding('billing.read')).map(([id]) => id)).toEqual([
      'home',
      'reports',
      'settings',
    ]);
    expect(entries(holding('support.grant')).map(([id]) => id)).toEqual(['home', 'settings']);
  });

  it('opens the first page the person can see, not the first of the group', () => {
    expect(entries(holding('tools.read', 'memory.read'))).toContainEqual(['ai', '/memory']);
    expect(entries(holding('integrations.manage'))).toContainEqual(['ai', '/models']);
    expect(entries(holding('migration.review'))).toContainEqual(['settings', '/migration']);
    expect(entries(holding('webhooks.read', 'members.read'))).toContainEqual(['settings', '/team']);
    expect(entries(holding('commerce.read'))).toContainEqual(['sales', '/orders']);
  });

  it('follows the built-in roles', () => {
    // A support agent: the inbox, what the AI knows and may do, orders, and the team (read only).
    expect(entries(role('agent'))).toEqual([
      ['home', '/overview'],
      ['inbox', '/inbox'],
      ['ai', '/knowledge'],
      ['sales', '/orders'],
      ['settings', '/team'],
    ]);
    // Billing and finance reach Activity through analytics.read, and nothing else of the AI.
    expect(entries(role('billing'))).toEqual([
      ['home', '/overview'],
      ['ai', '/runs'],
      ['reports', '/reports'],
      ['settings', '/settings/billing'],
    ]);
    expect(entries(role('developer'))).toContainEqual(['settings', '/team']);
  });

  // The table "What each role sees" in docs/using-hamnivo.md: change it together with this one.
  it('gives each built-in role the pages the guide lists', () => {
    const pagesOf = (key: Parameters<typeof presetPermissions>[0]) =>
      Object.fromEntries(
        menuFor(role(key)).map((group) => [group.id, group.routes.map((route) => route.to)]),
      );
    const everything = {
      home: ['/overview'],
      inbox: ['/inbox'],
      ai: [
        '/agents',
        '/knowledge',
        '/memory',
        '/tools',
        '/checks',
        '/decisions',
        '/runs',
        '/caching',
        '/models',
      ],
      sales: ['/orders', '/finance'],
      reports: ['/reports'],
      settings: ['/brands', '/team', '/security', '/developer', '/migration', '/settings/billing'],
    };
    const home = { home: ['/overview'] };
    expect(pagesOf('owner')).toEqual(everything);
    expect(pagesOf('admin')).toEqual(everything);
    expect(pagesOf('supervisor')).toEqual({
      ...everything,
      ai: everything.ai.filter((page) => page !== '/models'),
      settings: ['/team'],
    });
    expect(pagesOf('agent')).toEqual({
      ...home,
      inbox: ['/inbox'],
      ai: ['/knowledge', '/tools', '/caching'],
      sales: ['/orders', '/finance'],
      settings: ['/team'],
    });
    expect(pagesOf('finance')).toEqual({
      ...home,
      ai: ['/runs'],
      sales: ['/orders', '/finance'],
      reports: ['/reports'],
      settings: ['/team'],
    });
    expect(pagesOf('knowledge_editor')).toEqual({
      ...home,
      inbox: ['/inbox'],
      ai: ['/agents', '/knowledge', '/caching'],
    });
    expect(pagesOf('developer')).toEqual({
      ...home,
      ai: ['/agents', '/models'],
      settings: ['/team', '/developer'],
    });
    expect(pagesOf('analyst')).toEqual({
      ...home,
      inbox: ['/inbox'],
      ai: ['/checks', '/decisions', '/runs'],
      reports: ['/reports'],
    });
    expect(pagesOf('billing')).toEqual({
      ...home,
      ai: ['/runs'],
      reports: ['/reports'],
      settings: ['/settings/billing'],
    });
  });
});

describe('where the person is', () => {
  it('is on a page or below it, but not on a page that only starts the same', () => {
    expect(isOnRoute('/agents', '/agents')).toBe(true);
    expect(isOnRoute('/agents', '/agents/agt_1')).toBe(true);
    expect(isOnRoute('/agents', '/agents/')).toBe(true);
    expect(isOnRoute('/agents', '/agents-old')).toBe(false);
    expect(isOnRoute('/agents', '/agent')).toBe(false);
    expect(isOnRoute('/memory', '/models')).toBe(false);
  });

  it('puts every path of a group, nested ones included, in that group', () => {
    const groups: Record<string, NavGroupId | undefined> = {
      '/overview': 'home',
      '/inbox': 'inbox',
      '/inbox/conv_1': 'inbox',
      '/agents': 'ai',
      '/agents/agt_1': 'ai',
      '/memory/cus_1': 'ai',
      '/runs': 'ai',
      '/orders/ord_1': 'sales',
      '/finance': 'sales',
      '/reports': 'reports',
      '/brands': 'settings',
      '/migration': 'settings',
      '/settings/billing': 'settings',
      '/stop-ai': undefined,
      '/account': undefined,
      '/platform': undefined,
      '/nowhere': undefined,
    };
    for (const [path, id] of Object.entries(groups)) {
      expect(groupIdOfPath(path), path).toBe(id);
    }
  });

  it('finds the page of a group that a path is on', () => {
    const ai = NAV_GROUPS.find((group) => group.id === 'ai');
    expect(ai && currentRoute(ai, '/agents/agt_1')).toBe('/agents');
    expect(ai && currentRoute(ai, '/memory/cus_1')).toBe('/memory');
    expect(ai && currentRoute(ai, '/orders')).toBeUndefined();
  });
});

describe('the row of pages above a page', () => {
  it('lists the pages of the current entry when two or more can be seen', () => {
    const menu = menuFor(role('owner'));
    expect(sectionOf(menu, '/agents/agt_1')?.routes.map((route) => route.to)).toEqual([
      '/agents',
      '/knowledge',
      '/memory',
      '/tools',
      '/checks',
      '/decisions',
      '/runs',
      '/caching',
      '/models',
    ]);
    expect(sectionOf(menu, '/orders/ord_1')?.id).toBe('sales');
    expect(sectionOf(menu, '/security')?.id).toBe('settings');
  });

  it('lists only the pages this person can see', () => {
    const menu = menuFor(role('agent'));
    expect(sectionOf(menu, '/knowledge')?.routes.map((route) => route.to)).toEqual([
      '/knowledge',
      '/tools',
      '/caching',
    ]);
    // Customer memory is not theirs to see, so it is not a tab, even on its own (denied) page.
    expect(sectionOf(menu, '/memory')?.routes.map((route) => route.to)).not.toContain('/memory');
  });

  it('is left out for a single page, for pages outside any entry and for unseen entries', () => {
    const owner = menuFor(role('owner'));
    expect(sectionOf(owner, '/overview')).toBeUndefined();
    expect(sectionOf(owner, '/inbox/conv_1')).toBeUndefined();
    expect(sectionOf(owner, '/reports')).toBeUndefined();
    expect(sectionOf(owner, '/stop-ai')).toBeUndefined();
    expect(sectionOf(owner, '/account')).toBeUndefined();
    // One page of the AI entry is one page: no row.
    expect(sectionOf(menuFor(holding('tools.read')), '/tools')).toBeUndefined();
    // The settings entry is not theirs at all.
    expect(sectionOf(menuFor(holding('conversations.read')), '/brands')).toBeUndefined();
  });
});
