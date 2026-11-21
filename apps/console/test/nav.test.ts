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
  sectionOf,
} from '../src/lib/nav';

const holding = (...permissions: string[]) => {
  const held = new Set(permissions);
  return (permission: string) => held.has(permission);
};
const role = (key: Parameters<typeof presetPermissions>[0]) => holding(...presetPermissions(key));
/** The server's default: frozen features are not listed. */
const OFF = { advanced: false };
const ON = { advanced: true };
const FROZEN = ['/workflows', '/checks', '/decisions', '/orders', '/finance', '/migration'];
const entries = (can: (permission: string) => boolean) =>
  menuFor(can, OFF).map((group) => [group.id, group.to]);
describe('the grouped platform menu', () => {
  it('uses five focused sections in order', () =>
    expect(NAV_GROUPS.map((group) => group.id)).toEqual([
      'home',
      'inbox',
      'ai',
      'knowledge',
      'settings',
    ]));
  it('keeps commerce, legacy automations and advanced AI tools reachable', () => {
    expect(groupIdOfPath('/orders/ord_1')).toBe('settings');
    expect(groupIdOfPath('/finance')).toBe('settings');
    expect(groupIdOfPath('/automations')).toBe('ai');
    expect(groupIdOfPath('/tools')).toBe('ai');
    expect(groupIdOfPath('/connectors')).toBe('ai');
    expect(groupIdOfPath('/channels')).toBe('settings');
    expect(groupIdOfPath('/reports')).toBe('home');
    expect(groupIdOfPath('/knowledge')).toBe('knowledge');
    expect(groupIdOfPath('/runs')).toBe('ai');
    const routes = NAV_GROUPS.flatMap((g) => g.routes);
    for (const path of ['/orders', '/finance', '/tools', '/models', '/runs', '/caching'])
      expect(routes.find((r) => r.to === path)?.advanced).toBe(true);
  });
  it('lists the frozen pages only when the server turns advanced features on', () => {
    const routes = NAV_GROUPS.flatMap((g) => g.routes);
    expect(routes.filter((r) => r.frozen).map((r) => r.to)).toEqual(FROZEN);
    // Frozen pages sit behind the Advanced disclosure when they are listed.
    for (const path of FROZEN) expect(routes.find((r) => r.to === path)?.advanced).toBe(true);
    const listed = (features: { advanced: boolean }) =>
      menuFor(role('owner'), features).flatMap((g) => g.routes.map((r) => r.to));
    for (const path of FROZEN) {
      expect(listed(OFF)).not.toContain(path);
      expect(listed(ON)).toContain(path);
      // The page still belongs to its group, so its entry is active there when opened by address.
      expect(groupIdOfPath(path)).toBeDefined();
    }
    expect(menuFor(role('owner'), OFF).map((g) => g.id)).toEqual([
      'home',
      'inbox',
      'ai',
      'knowledge',
      'settings',
    ]);
  });
  it('gives every primary Studio page one place; agency context lives in the header', () => {
    const folder = fileURLToPath(new URL('../src/routes/_studio', import.meta.url));
    const pages = readdirSync(folder, { withFileTypes: true }).map(
      (entry) => `/${entry.name.replace(/\.tsx$/, '').replaceAll('.', '/')}`,
    );
    const elsewhere = [
      '/stop-ai',
      '/account',
      '/onboarding',
      '/visitors',
      '/saved-replies',
      '/blocked',
      '/connect/mcp',
      '/agency',
    ];
    const placed = NAV_GROUPS.flatMap((group) => group.routes.map((route) => route.to));
    expect([...new Set(pages)].filter((p) => !elsewhere.includes(p)).sort()).toEqual(
      [...placed].sort(),
    );
    expect(new Set(placed).size).toBe(placed.length);
  });
  it('shows only Home without permissions', () =>
    expect(entries(holding())).toEqual([['home', '/overview']]));
  it('opens the first permitted page of a section', () => {
    expect(entries(holding('memory.read', 'tools.read'))).toContainEqual(['ai', '/memory']);
    expect(entries(holding('tools.read'))).toContainEqual(['ai', '/connectors']);
    // Only frozen pages: no Settings entry until advanced features are on.
    expect(entries(holding('commerce.read'))).toEqual([['home', '/overview']]);
    const advanced = (can: (permission: string) => boolean) =>
      menuFor(can, ON).map((group) => [group.id, group.to]);
    expect(advanced(holding('commerce.read'))).toContainEqual(['settings', '/orders']);
    expect(advanced(holding('migration.review'))).toContainEqual(['settings', '/migration']);
  });
  it('does not expose unrelated resources when a role can use connectors or workflows', () => {
    const tools = menuFor(holding('tools.read'), OFF).find((g) => g.id === 'ai');
    expect(tools?.routes.map((r) => r.to)).toEqual(['/connectors', '/tools']);
    const automations = (features: { advanced: boolean }) =>
      menuFor(holding('automations.read'), features)
        .find((g) => g.id === 'ai')
        ?.routes.map((r) => r.to);
    expect(automations(OFF)).toEqual(['/connectors', '/automations']);
    expect(automations(ON)).toEqual(['/connectors', '/automations', '/workflows']);
    expect(entries(holding('conversations.read'))).toEqual([
      ['home', '/overview'],
      ['inbox', '/inbox'],
    ]);
  });
  it('preserves every page permission across built-in roles', () => {
    for (const key of [
      'owner',
      'admin',
      'supervisor',
      'agent',
      'finance',
      'knowledge_editor',
      'developer',
      'analyst',
      'billing',
    ] as const) {
      const can = role(key);
      for (const group of menuFor(can, ON))
        for (const route of group.routes) {
          expect(!route.permission || can(route.permission)).toBe(true);
          expect(!route.anyOf || route.anyOf.some(can)).toBe(true);
        }
    }
    const permissions = Object.fromEntries(
      NAV_GROUPS.flatMap((g) => g.routes.map((r) => [r.to, r.permission ?? r.anyOf ?? null])),
    );
    expect(permissions).toMatchObject({
      '/inbox': 'conversations.read',
      '/agents': 'agents.read',
      '/knowledge': 'knowledge.read',
      '/memory': 'memory.read',
      '/tools': 'tools.read',
      '/orders': 'commerce.read',
      '/finance': 'commerce.read',
      '/workflows': 'automations.read',
      '/automations': 'automations.read',
      '/chat-widget': 'widget.configure',
      '/customer-identity': 'widget.identity_keys',
      '/settings/privacy': ['privacy.manage', 'customers.export', 'customers.erase'],
    });
  });
  it('matches nested routes without matching unrelated prefixes', () => {
    expect(isOnRoute('/agents', '/agents/agt_1')).toBe(true);
    expect(isOnRoute('/agents', '/agents-old')).toBe(false);
    expect(isOnRoute('/agents', '/agents/')).toBe(true);
    expect(groupIdOfPath('/agency')).toBeUndefined();
    expect(groupIdOfPath('/nowhere')).toBeUndefined();
    const ai = NAV_GROUPS.find((g) => g.id === 'ai');
    expect(ai && currentRoute(ai, '/agents/agt_1')).toBe('/agents');
  });
  it('filters section tabs by permission and omits single-route sections', () => {
    expect(sectionOf(menuFor(role('agent'), OFF), '/knowledge')?.routes.map((r) => r.to)).toEqual([
      '/knowledge',
      '/caching',
    ]);
    expect(
      sectionOf(menuFor(role('agent'), OFF), '/memory')?.routes.map((r) => r.to),
    ).not.toContain('/memory');
    expect(sectionOf(menuFor(role('owner'), OFF), '/inbox')).toBeUndefined();
    expect(sectionOf(menuFor(role('owner'), OFF), '/orders/ord_1')?.id).toBe('settings');
    expect(sectionOf(menuFor(holding(), OFF), '/agents')).toBeUndefined();
  });
});

describe('unchanged resource permissions', () => {
  it('keeps every existing page permission exactly', () => {
    const permissions = Object.fromEntries(
      NAV_GROUPS.flatMap((group) =>
        group.routes.map((route) => [route.to, route.permission ?? route.anyOf ?? null]),
      ),
    );
    expect(permissions).toEqual({
      '/branding': 'branding.read',
      '/workflows': 'automations.read',
      '/connectors': ['integrations.manage', 'tools.read', 'automations.read'],
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
      // The chat's look, behaviour, forms, consent and link: for whoever configures the widget.
      '/chat-widget': 'widget.configure',
      // Email, WhatsApp and Telegram through Chatwoot: for whoever connects services.
      '/channels': 'integrations.manage',
      // Website prompts and chat rules: seen by whoever may read automations, changed by managers.
      '/automations': 'automations.read',
      '/hours': 'brands.manage',
      '/team': 'members.read',
      '/support-teams': 'members.read',
      '/security': ['security.manage', 'support.grant'],
      '/developer': ['api_keys.read', 'webhooks.read', 'network.manage'],
      '/customer-identity': 'widget.identity_keys',
      '/migration': 'migration.review',
      '/settings/billing': ['billing.read', 'settings.manage'],
      // Retention for owners; one customer's data for whoever may export or erase customers.
      '/settings/privacy': ['privacy.manage', 'customers.export', 'customers.erase'],
    });
  });
});

describe('built-in role resource access', () => {
  it('gives each built-in role the pages the guide lists', () => {
    // With frozen pages listed, so every page a role could reach before the freeze is checked.
    const legacyPages = (key: Parameters<typeof presetPermissions>[0]) =>
      Object.fromEntries(
        menuFor(role(key), ON).map((group) => [group.id, group.routes.map((route) => route.to)]),
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
      settings: [
        '/brands',
        '/chat-widget',
        '/channels',
        '/automations',
        '/hours',
        '/team',
        '/support-teams',
        '/security',
        '/developer',
        '/customer-identity',
        '/migration',
        '/settings/billing',
        '/settings/privacy',
      ],
    };
    const home = { home: ['/overview'] };
    const flatten = (value: Record<string, string[]>) => Object.values(value).flat().sort();
    const pagesOf = (key: Parameters<typeof presetPermissions>[0]) =>
      flatten(legacyPages(key)).filter(
        (path) => !['/workflows', '/connectors', '/branding'].includes(path),
      );
    const expected = (value: Record<string, string[]>) => flatten(value);
    expect(pagesOf('owner')).toEqual(expected(everything));
    // Administrators reach Privacy for one customer's data; retention stays the owners' (A10).
    expect(pagesOf('admin')).toEqual(expected(everything));
    expect(pagesOf('supervisor')).toEqual(
      expected({
        ...everything,
        ai: everything.ai.filter((page) => page !== '/models'),
        settings: ['/automations', '/team', '/support-teams'],
      }),
    );
    expect(pagesOf('agent')).toEqual(
      expected({
        ...home,
        inbox: ['/inbox'],
        ai: ['/knowledge', '/tools', '/caching'],
        sales: ['/orders', '/finance'],
        settings: ['/team', '/support-teams'],
      }),
    );
    expect(pagesOf('finance')).toEqual(
      expected({
        ...home,
        ai: ['/runs'],
        sales: ['/orders', '/finance'],
        reports: ['/reports'],
        settings: ['/team', '/support-teams'],
      }),
    );
    expect(pagesOf('knowledge_editor')).toEqual(
      expected({
        ...home,
        inbox: ['/inbox'],
        ai: ['/agents', '/knowledge', '/caching'],
      }),
    );
    expect(pagesOf('developer')).toEqual(
      expected({
        ...home,
        ai: ['/agents', '/models'],
        settings: ['/chat-widget', '/channels', '/team', '/support-teams', '/developer'],
      }),
    );
    expect(pagesOf('analyst')).toEqual(
      expected({
        ...home,
        inbox: ['/inbox'],
        ai: ['/checks', '/decisions', '/runs'],
        reports: ['/reports'],
      }),
    );
    expect(pagesOf('billing')).toEqual(
      expected({
        ...home,
        ai: ['/runs'],
        reports: ['/reports'],
        settings: ['/settings/billing'],
      }),
    );
  });
});
