import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../lib/queries';
import { redirectSearch } from '../lib/redirects';
import { SignInPage } from '../pages/SignInPage';

export const Route = createFileRoute('/sign-in')({
  validateSearch: redirectSearch,
  beforeLoad: async ({ context, search }) => {
    // Someone already signed in goes straight on.
    const me = await context.queryClient.ensureQueryData(meQuery()).catch(() => null);
    if (me) throw redirect({ href: search.redirect ?? '/overview' });
  },
  component: SignInPage,
});
