import { createFileRoute, redirect } from '@tanstack/react-router';
import { isSignedOut } from '../lib/api';
import { meQuery } from '../lib/queries';
import { PlatformPage } from '../pages/platform/PlatformPage';

export type PlatformView = 'tenants' | 'health' | 'support' | 'incidents' | 'audit' | 'saas';
const VIEWS: readonly PlatformView[] = [
  'tenants',
  'health',
  'support',
  'incidents',
  'audit',
  'saas',
];
const AREAS = ['configuration', 'conversations', 'audit'] as const;

export interface PlatformSearch {
  view?: PlatformView;
  tenant?: string;
  grant?: string;
  area?: (typeof AREAS)[number];
  q?: string;
}

/** The platform operations console (A17, board 26): its own layout, no tenant chosen. */
export const Route = createFileRoute('/platform')({
  validateSearch: (search: Record<string, unknown>): PlatformSearch => ({
    ...(VIEWS.includes(search.view as PlatformView) && search.view !== 'tenants'
      ? { view: search.view as PlatformView }
      : {}),
    ...(typeof search.tenant === 'string' && search.tenant ? { tenant: search.tenant } : {}),
    ...(typeof search.grant === 'string' && search.grant ? { grant: search.grant } : {}),
    ...(AREAS.includes(search.area as (typeof AREAS)[number])
      ? { area: search.area as (typeof AREAS)[number] }
      : {}),
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
  }),
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
  component: PlatformPage,
});
