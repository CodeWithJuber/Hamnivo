/**
 * Renders a Studio screen to HTML in Node, as a signed-in member with chosen permissions, at a
 * chosen address. No browser: what a screen shows on its first render (its data comes from the
 * query cache, which a test fills first) is read back with the small helpers below.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { TenantProvider } from '../src/lib/tenant';
import type { Me, TenantSummary } from '../src/lib/types';

export const TENANT_ID = 'tnt_test';
export const SELF_ID = 'staff_me';

const tenant = {
  id: TENANT_ID,
  slug: 'noor-books',
  name: 'Noor Books',
  status: 'active',
} as TenantSummary;

/** Every address a screen links to or sits on; the pages themselves are not rendered. */
const PATHS = [
  '/overview',
  '/inbox',
  '/inbox/$conversationId',
  '/visitors',
  '/agents',
  '/agents/$agentId',
  '/knowledge',
  '/memory',
  '/memory/$customerId',
  '/tools',
  '/checks',
  '/decisions',
  '/runs',
  '/caching',
  '/models',
  '/orders',
  '/orders/$orderId',
  '/finance',
  '/reports',
  '/brands',
  '/team',
  '/security',
  '/developer',
  '/migration',
  '/stop-ai',
  '/account',
  '/tenants',
];

function memberWith(permissions: readonly string[]): Me {
  return {
    user: {
      id: 'usr_1',
      name: 'Omar Agent',
      email: 'omar@example.com',
      emailVerified: true,
      twoFactorEnabled: false,
    },
    memberships: [],
    current: {
      tenantId: TENANT_ID,
      staffMemberId: SELF_ID,
      permissions: [...permissions],
      mfa: false,
    },
  } as Me;
}

export async function renderStudio({
  at,
  permissions,
  screen,
  seed,
}: {
  /** The address the person is at, such as `/agents/agt_1`. */
  at: string;
  permissions: readonly string[];
  screen: ReactNode;
  /** Puts data in the query cache, under keys that start with the tenant. */
  seed?: (client: QueryClient) => void;
}): Promise<string> {
  // Nothing is fetched while rendering to HTML; seeded data is what a screen finds in the cache.
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  seed?.(client);
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren(
      PATHS.map((path) => createRoute({ getParentRoute: () => root, path })),
    ),
    history: createMemoryHistory({ initialEntries: [at] }),
    // The root has no component of its own, so the screen takes its place.
    defaultComponent: () => <>{screen}</>,
  });
  await router.load();
  return renderToString(
    <QueryClientProvider client={client}>
      <TenantProvider me={memberWith(permissions)} tenant={tenant}>
        <RouterProvider router={router} />
      </TenantProvider>
    </QueryClientProvider>,
  );
}

// ------------------------------------------------------------------ reading the HTML back

export interface Anchor {
  href: string;
  /** What a person reads in the link. */
  text: string;
  attrs: Record<string, string>;
}

const decode = (text: string) =>
  text
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const attributesOf = (source: string): Record<string, string> =>
  Object.fromEntries(
    [...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
      match[1] ?? '',
      decode(match[2] ?? ''),
    ]),
  );

export const textOf = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();

/** Every link in a piece of HTML, in order. */
export function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => {
    const attrs = attributesOf(match[1] ?? '');
    return { href: attrs.href ?? '', text: textOf(match[2] ?? ''), attrs };
  });
}

/** The links of the navigation landmark with this name, or undefined when there is none. */
export function navigation(html: string, label: string): Anchor[] | undefined {
  for (const match of html.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)) {
    if (attributesOf(match[1] ?? '')['aria-label'] === label) return anchors(match[2] ?? '');
  }
  return undefined;
}

/** The link marked as the page being shown (aria-current), by its address. */
export const current = (links: readonly Anchor[] | undefined) =>
  (links ?? []).filter((link) => link.attrs['aria-current'] === 'page').map((link) => link.href);
