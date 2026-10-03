import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../lib/queries';
import { redirectSearch } from '../lib/redirects';
import { SignInPage } from '../pages/SignInPage';

export interface SignInSearch {
  redirect?: string;
  /** Why single sign-on failed, as the gateway reported it (A13). */
  error?: string;
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...redirectSearch(search),
    ...(typeof search.error === 'string' && /^[a-z_]{1,60}$/.test(search.error)
      ? { error: search.error }
      : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    // Someone already signed in goes straight on.
    const me = await context.queryClient.ensureQueryData(meQuery()).catch(() => null);
    if (me) throw redirect({ href: search.redirect ?? '/overview' });
  },
  component: SignInPage,
});
