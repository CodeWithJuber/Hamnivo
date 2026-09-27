import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, isSignedOut } from './api';
import { reauth } from './reauth';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** A Studio screen's data: a lost session opens the sign-in dialog over the page. */
      studio?: boolean;
    };
  }
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error, query) {
      if (query.meta?.studio && isSignedOut(error)) {
        reauth.request('expired').then(
          () => queryClient.invalidateQueries(),
          () => undefined,
        );
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Retry only what can succeed on its own: network hiccups and retryable problems.
      retry: (count, error) =>
        count < 2 &&
        error instanceof ApiError &&
        (error.code === 'NETWORK' || error.problem?.retryable === true),
    },
    mutations: { retry: false },
  },
});
