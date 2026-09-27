import { createRouter } from '@tanstack/react-router';
import { NotFoundPage, PageError, PagePending } from './components/RouteStates';
import { queryClient } from './lib/query-client';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  // Studio data lives in TanStack Query; the router only decides where people may go.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingComponent: PagePending,
  defaultErrorComponent: PageError,
  defaultNotFoundComponent: NotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
