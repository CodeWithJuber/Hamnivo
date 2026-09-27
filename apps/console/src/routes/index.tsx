import { createFileRoute, redirect } from '@tanstack/react-router';

/** The start page is the overview; the Studio layout sends people to sign in first if needed. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/overview' });
  },
});
