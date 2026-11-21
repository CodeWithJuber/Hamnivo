/**
 * Studio's menu: five sections (Home, Inbox, AI, Knowledge, Settings) with advanced pages
 * available through a disclosure. Existing resources keep their permission checks as the menu is
 * regrouped.
 *
 * - An entry shows when the person can see at least one of its pages, and opens the first page
 *   they can see.
 * - An entry is active on every path of its group, nested ones included (`/agents/:id`).
 * - A group with two or more visible pages also lists them as a row of links above the page
 *   (SectionTabs), so the pages are one click away without a long menu.
 *
 * - A frozen page (the freeze list of the production-ready plan, 2026-11-20) is left out unless the
 *   server turns advanced features on (`HAMNIVO_ADVANCED_FEATURES`, sent in `/v1/me`). Its data
 *   and its address keep working: the freeze takes it out of everyday use, not out of the product.
 *
 * The menu is filtered by role; the gateway still checks every request (HNV-03-05).
 */

/** Every page that has a place in the menu. `/stop-ai`, `/account` and `/onboarding` live elsewhere. */
export type NavPath =
  | '/branding'
  | '/connectors'
  | '/workflows'
  | '/overview'
  | '/inbox'
  | '/agents'
  | '/knowledge'
  | '/memory'
  | '/tools'
  | '/checks'
  | '/decisions'
  | '/runs'
  | '/caching'
  | '/models'
  | '/orders'
  | '/finance'
  | '/reports'
  | '/brands'
  | '/chat-widget'
  | '/channels'
  | '/automations'
  | '/hours'
  | '/team'
  | '/support-teams'
  | '/security'
  | '/developer'
  | '/migration'
  | '/settings/billing'
  | '/settings/privacy'
  | '/customer-identity';

export type NavGroupId = 'home' | 'inbox' | 'ai' | 'knowledge' | 'settings';

export interface NavRoute {
  to: NavPath;
  /** Shown when the person holds this permission. */
  permission?: string;
  /** Shown when the person holds any of these. */
  anyOf?: readonly string[];
  advanced?: boolean;
  /** On the freeze list: shown only when the server turns advanced features on. */
  frozen?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  /** In the order people see them: the first one they can see is where the entry leads. */
  routes: readonly NavRoute[];
}

export type Can = (permission: string) => boolean;

/** What the server switched on for Studio (`/v1/me` `features`). */
export interface NavFeatures {
  /** Frozen pages are listed. */
  advanced: boolean;
}

/** Each page keeps the permission it had in the flat list this replaces. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'home',
    routes: [{ to: '/overview' }, { to: '/reports', anyOf: ['analytics.read', 'billing.read'] }],
  },
  { id: 'inbox', routes: [{ to: '/inbox', permission: 'conversations.read' }] },
  {
    id: 'ai',
    routes: [
      { to: '/agents', permission: 'agents.read' },
      { to: '/memory', permission: 'memory.read' },
      { to: '/connectors', anyOf: ['integrations.manage', 'tools.read', 'automations.read'] },
      { to: '/automations', permission: 'automations.read', advanced: true },
      { to: '/tools', permission: 'tools.read', advanced: true },
      { to: '/models', permission: 'integrations.manage', advanced: true },
      { to: '/runs', advanced: true, permission: 'analytics.read' },
      { to: '/workflows', permission: 'automations.read', advanced: true, frozen: true },
      { to: '/checks', advanced: true, frozen: true, permission: 'decisions.read' },
      { to: '/decisions', advanced: true, frozen: true, permission: 'decisions.read' },
    ],
  },
  {
    id: 'knowledge',
    routes: [
      { to: '/knowledge', permission: 'knowledge.read' },
      { to: '/caching', advanced: true, permission: 'knowledge.read' },
    ],
  },
  {
    id: 'settings',
    routes: [
      { to: '/brands', permission: 'brands.manage' },
      { to: '/branding', permission: 'branding.read' },
      { to: '/chat-widget', permission: 'widget.configure' },
      { to: '/channels', permission: 'integrations.manage' },
      { to: '/hours', permission: 'brands.manage' },
      { to: '/team', permission: 'members.read' },
      { to: '/support-teams', advanced: true, permission: 'members.read' },
      { to: '/security', advanced: true, anyOf: ['security.manage', 'support.grant'] },
      {
        to: '/developer',
        advanced: true,
        anyOf: ['api_keys.read', 'webhooks.read', 'network.manage'],
      },
      { to: '/customer-identity', advanced: true, permission: 'widget.identity_keys' },
      { to: '/orders', permission: 'commerce.read', advanced: true, frozen: true },
      { to: '/finance', permission: 'commerce.read', advanced: true, frozen: true },
      { to: '/migration', advanced: true, frozen: true, permission: 'migration.review' },
      { to: '/settings/billing', anyOf: ['billing.read', 'settings.manage'] },
      {
        to: '/settings/privacy',
        anyOf: ['privacy.manage', 'customers.export', 'customers.erase'],
      },
    ],
  },
];

function canSee(route: NavRoute, can: Can, features: NavFeatures): boolean {
  return (
    (!route.frozen || features.advanced) &&
    (!route.permission || can(route.permission)) &&
    (!route.anyOf || route.anyOf.some((permission) => can(permission)))
  );
}

/** A group as one person sees it: only the pages they can open. */
export interface MenuGroup {
  id: NavGroupId;
  /** The first page they can see. */
  to: NavPath;
  routes: readonly NavRoute[];
}

/** The entries for someone holding these permissions; a group with no visible page is left out. */
export function menuFor(can: Can, features: NavFeatures): MenuGroup[] {
  const menu: MenuGroup[] = [];
  for (const group of NAV_GROUPS) {
    const routes = group.routes.filter((route) => canSee(route, can, features));
    const first = routes[0];
    if (first) menu.push({ id: group.id, to: first.to, routes });
  }
  return menu;
}

/** Whether a path is the page or below it: `/agents` and `/agents/agt_1`, not `/agents-old`. */
export function isOnRoute(to: NavPath, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === to || path.startsWith(`${to}/`);
}

/** The group a path belongs to, whether or not this person can see its entry. */
export function groupIdOfPath(pathname: string): NavGroupId | undefined {
  return NAV_GROUPS.find((group) => group.routes.some((route) => isOnRoute(route.to, pathname)))
    ?.id;
}

/** The page of a group a path is on, if any (a group's other pages are not it). */
export function currentRoute(group: Pick<MenuGroup, 'routes'>, pathname: string) {
  return group.routes.find((route) => isOnRoute(route.to, pathname))?.to;
}

/**
 * The group whose pages are listed above the current page: the group the path is in, when this
 * person can see two or more of its pages.
 */
export function sectionOf(menu: readonly MenuGroup[], pathname: string): MenuGroup | undefined {
  const id = groupIdOfPath(pathname);
  const group = menu.find((entry) => entry.id === id);
  return group && group.routes.length > 1 ? group : undefined;
}
