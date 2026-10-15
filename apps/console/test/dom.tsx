/**
 * Mounts a Studio screen in a DOM (jsdom) so a test can type, press buttons and see what the
 * screen asks the gateway for. Everything the gateway would answer is faked: `fakeGateway` puts a
 * stand-in where `fetch` is and records every request, so a test reads back exactly what was sent.
 * Screens rendered to HTML (render.tsx) cover what a page shows first; this covers what it does.
 */
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, type RenderResult, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, vi } from 'vitest';
import { TenantProvider } from '../src/lib/tenant';
import type { Me, TenantSummary } from '../src/lib/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom lacks browser APIs that Radix and the page use.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

export const TENANT_ID = 'tnt_test';
export const SELF_ID = 'staff_me';

const tenant = {
  id: TENANT_ID,
  slug: 'noor-books',
  name: 'Noor Books',
  status: 'active',
} as TenantSummary;

const PATHS = [
  '/overview',
  '/inbox',
  '/inbox/$conversationId',
  '/brands',
  '/chat-widget',
  '/channels',
  '/hours',
  '/team',
  '/support-teams',
  '/customer-identity',
  '/models',
  '/onboarding',
  '/decisions',
  // Where the command palette's tests go.
  '/knowledge',
  '/agents',
  '/agents/$agentId',
  '/settings/billing',
  '/visitors',
];

const memberWith = (permissions: readonly string[]): Me =>
  ({
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
  }) as Me;

export interface Mounted extends RenderResult {
  client: QueryClient;
  router: AnyRouter;
}

/** Mounts a screen as a signed-in member with these permissions, at an address. */
export async function mountStudio({
  at = '/overview',
  permissions,
  screen,
  seed,
}: {
  at?: string;
  permissions: readonly string[];
  screen: ReactNode;
  /** Puts data in the query cache, under keys that start with the tenant. */
  seed?: (client: QueryClient) => void;
}): Promise<Mounted> {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  seed?.(client);
  const root = createRootRoute();
  const studio = createRoute({ getParentRoute: () => root, id: '_studio' });
  const router = createRouter({
    routeTree: root.addChildren([
      studio.addChildren(PATHS.map((path) => createRoute({ getParentRoute: () => studio, path }))),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
    defaultComponent: () => <>{screen}</>,
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={client}>
      <TenantProvider me={memberWith(permissions)} tenant={tenant}>
        <AnnouncerProvider>
          <RouterProvider router={router} />
        </AnnouncerProvider>
      </TenantProvider>
    </QueryClientProvider>,
  );
  return { client, router, ...view };
}

/** What the screen sent to the gateway. */
export interface Call {
  method: string;
  path: string;
  /** The query string's values (`?queue=tickets` → { queue: 'tickets' }). */
  query: Record<string, string>;
  /** The JSON body that was sent, or undefined for none. */
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** What a fake answers: JSON for success, or a problem the way the gateway sends one. */
export type Answer =
  | { status?: number; json?: unknown }
  | {
      problem: {
        status: number;
        code: string;
        fields?: { path: string; message: string }[];
        /** Anything else the problem carries, such as who owns a conversation now. */
        [extra: string]: unknown;
      };
    };

/**
 * Stands in for the gateway. Routes are `"POST /v1/admin/brands"` (the path without the query);
 * a route may answer differently each time by being a function of the call. A request nobody
 * planned for answers 404 and is recorded, so the test fails on it by name.
 */
export function fakeGateway(routes: Record<string, Answer | ((call: Call) => Answer)>) {
  const calls: Call[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://gateway.test');
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    };
    calls.push(call);
    const planned = routes[`${call.method} ${call.path}`];
    if (!planned) {
      return Response.json(
        { status: 404, code: 'NOT_FOUND', title: `unplanned ${call.method} ${call.path}` },
        { status: 404 },
      );
    }
    const answer = typeof planned === 'function' ? planned(call) : planned;
    if ('problem' in answer) {
      return Response.json(
        { title: 'Problem', ...answer.problem },
        { status: answer.problem.status },
      );
    }
    return answer.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(answer.json ?? {}, { status: answer.status ?? 200 });
  };
  vi.stubGlobal('fetch', fake);
  return {
    calls,
    /** The requests made to a route, in order. */
    to: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
    /** Everything that changed something (a screen also reads lists nobody planned for). */
    writes: () => calls.filter((call) => call.method !== 'GET'),
  };
}

/** Lets pending promises and effects run, so a screen shows what an answer led to. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
