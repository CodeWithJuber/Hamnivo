import { createFileRoute, redirect } from '@tanstack/react-router';
import { isSignedOut } from '../lib/api';
import { meQuery } from '../lib/queries';
import { redirectSearch } from '../lib/redirects';
import { TenantsPage } from '../pages/TenantsPage';

export const Route = createFileRoute('/tenants')({
  validateSearch: redirectSearch,
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery());
    } catch (error) {
      if (isSignedOut(error)) {
        throw redirect({ to: '/sign-in', search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: TenantsPage,
});
