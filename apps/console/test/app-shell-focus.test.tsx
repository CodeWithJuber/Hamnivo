// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';
import { initI18n } from '../src/i18n';
import { TenantProvider } from '../src/lib/tenant';
import type { Me, TenantSummary } from '../src/lib/types';
import { fakeGateway } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const me = {
  user: {
    id: 'usr_1',
    name: 'Omar Agent',
    email: 'omar@example.com',
    emailVerified: true,
    twoFactorEnabled: false,
  },
  memberships: [],
  current: {
    tenantId: 'tnt_test',
    staffMemberId: 'staff_me',
    permissions: [...presetPermissions('owner')],
    mfa: false,
  },
  features: { advanced: false },
} as Me;
const tenant = { id: 'tnt_test', slug: 'noor-books', name: 'Noor Books', status: 'active' };

/**
 * Studio's frame around two pages of their own, as in the app (each page is its own component,
 * so leaving one removes its heading). Billing loads only when the test lets it, standing in
 * for a page whose code or data is slow to arrive.
 */
function mountShell() {
  // The shell's own reads (kill switches, agency, …) are answered 404 and shown as nothing.
  fakeGateway({});
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const page = (title: string) => () => (
    <h1 id="page-title" tabIndex={-1}>
      {title}
    </h1>
  );
  const root = createRootRoute();
  const studio = createRoute({
    getParentRoute: () => root,
    id: '_studio',
    component: () => (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      studio.addChildren([
        createRoute({ getParentRoute: () => studio, path: '/overview', component: page('Home') }),
        createRoute({
          getParentRoute: () => studio,
          path: '/settings/billing',
          component: page('Plan and billing'),
          loader: () => held,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ['/overview'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TenantProvider me={me} tenant={tenant as TenantSummary}>
        <AnnouncerProvider>
          <RouterProvider router={router} />
        </AnnouncerProvider>
      </TenantProvider>
    </QueryClientProvider>,
  );
  return { router, release };
}

const frames = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('focus after moving to another page', () => {
  it('leaves the first page of a visit where the browser starts', async () => {
    mountShell();
    await screen.findByRole('heading', { name: 'Home' });
    await frames();
    expect(document.activeElement).toBe(document.body);
  });

  it('goes to the new page’s heading once that page is shown, however long it takes to load', async () => {
    const { router, release } = mountShell();
    await screen.findByRole('heading', { name: 'Home' });
    void router.navigate({ to: '/settings/billing' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/billing'));
    // The address has changed, but the page it names is still loading: the old one stays.
    await frames();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy();

    release();
    const heading = await screen.findByRole('heading', { name: 'Plan and billing' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
