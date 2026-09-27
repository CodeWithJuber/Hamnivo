import { Button } from '@hamnivo/ui/components/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouteContext } from '@tanstack/react-router';
import { LockIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell } from '../components/AppShell';
import { AuthLayout } from '../components/AuthLayout';
import { PagePending } from '../components/RouteStates';
import { ErrorPanel } from '../components/States';
import { isSignedOut } from '../lib/api';
import { meInTenantQuery } from '../lib/queries';
import { chooseTenant, TenantProvider } from '../lib/tenant';
import type { TenantSummary } from '../lib/types';

/** Membership or permissions were removed: clear this tenant's data from the tab (HNV-02-06). */
function Revoked({ tenant }: { tenant: TenantSummary }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  useEffect(() => {
    client.removeQueries({ queryKey: [tenant.id] });
    chooseTenant(null);
  }, [client, tenant.id]);
  return (
    <AuthLayout title={t('tenants.revoked.title')}>
      <div className="flex flex-col gap-4" data-testid="access-revoked">
        <p className="flex items-start gap-2 text-sm text-text">
          <LockIcon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
          {t('tenants.revoked.description', { name: tenant.name })}
        </p>
        <Button asChild className="self-start">
          <Link to="/tenants">{t('nav.switchWorkspace')}</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}

export function StudioLayout() {
  const { tenant } = useRouteContext({ from: '/_studio' });
  const me = useQuery(meInTenantQuery(tenant.id));

  if (me.data === undefined) {
    // A lost session opens the sign-in dialog over this placeholder (see query-client.ts).
    if (me.error && !isSignedOut(me.error)) {
      return (
        <div className="mx-auto max-w-2xl p-4 sm:p-8">
          <ErrorPanel error={me.error} onRetry={() => me.refetch()} retrying={me.isRefetching} />
        </div>
      );
    }
    return <PagePending />;
  }
  const membership = me.data.memberships.find((m) => m.tenant.id === tenant.id);
  if (!me.data.current || membership?.status !== 'active') return <Revoked tenant={tenant} />;
  return (
    <TenantProvider me={me.data} tenant={membership.tenant}>
      <AppShell>
        <Outlet />
      </AppShell>
    </TenantProvider>
  );
}
