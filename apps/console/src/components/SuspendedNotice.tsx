import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { CirclePauseIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTenant } from '../lib/tenant';

/**
 * Shown on every page of a suspended workspace: people can look, nothing changes, and the chat on
 * the website shows offline until the provider reactivates it. Paying stays possible.
 */
export function SuspendedNotice() {
  const { t } = useTranslation();
  const { tenant, can } = useTenant();
  if (tenant.status !== 'suspended') return null;
  return (
    <div
      role="status"
      data-testid="suspended-banner"
      className="flex flex-wrap items-start gap-3 border-b border-warning/40 bg-warning-subtle px-4 py-3 sm:px-6 lg:px-8"
    >
      <CirclePauseIcon className="mt-0.5 size-5 shrink-0 text-text" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <p className="font-semibold text-text">{t('billing.suspended.title')}</p>
        <p className="text-text">{t('billing.suspended.description')}</p>
      </div>
      {can('billing.read') ? (
        <Button asChild variant="secondary" size="sm">
          <Link to="/settings/billing">{t('billing.nav')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
