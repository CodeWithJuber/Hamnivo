import { createFileRoute, redirect } from '@tanstack/react-router';
import { isSignedOut } from '../lib/api';
import { meQuery } from '../lib/queries';
import { activeTenantId, chooseTenant } from '../lib/tenant';
import type { Me } from '../lib/types';
import { StudioLayout } from '../pages/StudioLayout';

/**
 * Every Studio page needs a signed-in person and a tenant they belong to; otherwise they go to
 * sign in, then to the tenant choice, and come back here afterwards.
 */
export const Route = createFileRoute('/_studio')({
  beforeLoad: async ({ context, location }) => {
    let me: Me;
    try {
      me = await context.queryClient.ensureQueryData(meQuery());
    } catch (error) {
      if (isSignedOut(error)) {
        throw redirect({ to: '/sign-in', search: { redirect: location.href } });
      }
      throw error;
    }
    let tenantId = activeTenantId();
    const usable = me.memberships.filter(
      (m) => m.status === 'active' && m.tenant.status === 'active',
    );
    // Nothing remembered (a new browser, or after signing out) and only one choice: open it.
    if (!tenantId && usable.length === 1 && usable[0]) {
      tenantId = usable[0].tenant.id;
      chooseTenant(tenantId);
    }
    const membership = me.memberships.find((m) => m.tenant.id === tenantId);
    if (membership?.status !== 'active' || membership.tenant.status !== 'active') {
      throw redirect({ to: '/tenants', search: { redirect: location.href } });
    }
    return { tenant: membership.tenant };
  },
  component: StudioLayout,
});
