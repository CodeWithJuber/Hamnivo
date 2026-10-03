import { Button } from '@hamnivo/ui/components/button';
import { HamnivoMark } from '@hamnivo/ui/components/hamnivo-mark';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link, useSearch } from '@tanstack/react-router';
import {
  ActivityIcon,
  ArrowLeftIcon,
  Building2Icon,
  FileClockIcon,
  HeadsetIcon,
  LockIcon,
  SirenIcon,
  UserPlusIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSelect } from '../../components/LanguageSelect';
import { useDocumentTitle } from '../../components/PageHeader';
import { PagePending } from '../../components/RouteStates';
import { ErrorPanel } from '../../components/States';
import { isApiError } from '../../lib/api';
import { usePlatformMe } from '../../lib/platform';
import type { PlatformOperator } from '../../lib/types';
import type { PlatformView } from '../../routes/platform';
import { AuditView } from './AuditView';
import { HealthView } from './HealthView';
import { IncidentsView } from './IncidentsView';
import { SaasView } from './SaasView';
import { SupportView } from './SupportView';
import { TenantsView } from './TenantsView';

interface NavItem {
  view: PlatformView;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  permission: string;
}

const NAV: NavItem[] = [
  { view: 'tenants', icon: Building2Icon, permission: 'platform.tenants.read' },
  { view: 'health', icon: ActivityIcon, permission: 'platform.health.read' },
  { view: 'support', icon: HeadsetIcon, permission: 'platform.support.request' },
  { view: 'incidents', icon: SirenIcon, permission: 'platform.health.read' },
  { view: 'audit', icon: FileClockIcon, permission: 'platform.audit.read' },
  { view: 'saas', icon: UserPlusIcon, permission: 'platform.tenants.read' },
];

export const canPlatform = (operator: PlatformOperator, permission: string) =>
  operator.permissions.includes(permission);

function Console({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const search = useSearch({ from: '/platform' });
  const items = NAV.filter((item) => canPlatform(operator, item.permission));
  const view: PlatformView =
    items.find((item) => item.view === (search.view ?? 'tenants'))?.view ??
    items[0]?.view ??
    'tenants';
  // The SaaS view's text lives with the rest of plans and billing (i18n/billing).
  const label = (name: PlatformView) =>
    name === 'saas' ? t('billing.platform.nav') : t(`platform.nav.${name}`);
  useDocumentTitle(label(view));
  return (
    <div
      className="min-h-dvh bg-bg lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]"
      data-testid="platform-console"
    >
      <a
        href="#platform-main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md"
      >
        {t('app.skipToContent')}
      </a>
      <aside className="flex flex-col gap-4 border-b border-border bg-surface-muted p-4 lg:sticky lg:top-0 lg:h-dvh lg:border-e lg:border-b-0">
        <span className="flex items-center gap-2">
          <HamnivoMark className="size-7" />
          <span className="text-lg font-semibold text-text">{t('platform.title')}</span>
        </span>
        <nav aria-label={t('platform.nav.label')}>
          <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
            {items.map((item) => (
              <li key={item.view}>
                <Link
                  to="/platform"
                  search={{ view: item.view === 'tenants' ? undefined : item.view }}
                  activeOptions={{ includeSearch: true, explicitUndefined: true }}
                  className="relative flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-sunken hover:text-text aria-[current=page]:bg-surface-sunken aria-[current=page]:text-text"
                >
                  <item.icon className="size-[18px] shrink-0" aria-hidden />
                  {label(item.view)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex min-h-16 flex-wrap items-center gap-2 border-b border-border bg-bg px-4 py-2 sm:px-6 lg:px-8">
          <StatusBadge tone="brand" icon={<LockIcon className="size-3.5" aria-hidden="true" />}>
            {t(`platform.roles.${operator.role}`)}
          </StatusBadge>
          <span className="min-w-0 truncate text-sm text-text">
            <bdi>{operator.name}</bdi>
          </span>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link to="/overview">
                <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
                {t('platform.returnToWorkspace')}
              </Link>
            </Button>
            <LanguageSelect id="platform-language" />
          </div>
        </header>
        {!operator.mfa ? (
          <p className="border-b border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-text sm:px-6 lg:px-8">
            {t('platform.mfaNeeded')}
          </p>
        ) : null}
        <main
          id="platform-main"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8"
        >
          <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
            {label(view)}
          </h1>
          {view === 'tenants' ? <TenantsView operator={operator} /> : null}
          {view === 'health' ? <HealthView /> : null}
          {view === 'support' ? <SupportView operator={operator} /> : null}
          {view === 'incidents' ? <IncidentsView operator={operator} /> : null}
          {view === 'audit' ? <AuditView /> : null}
          {view === 'saas' ? <SaasView operator={operator} /> : null}
        </main>
      </div>
    </div>
  );
}

/** The platform operations console (A17, board 26), for platform operators only. */
export function PlatformPage() {
  const { t } = useTranslation();
  const me = usePlatformMe();
  if (me.isPending) return <PagePending />;
  if (me.data) return <Console operator={me.data} />;
  if (isApiError(me.error, 'NOT_FOUND')) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6" data-testid="not-operator">
        <h1 id="page-title" tabIndex={-1} className="text-2xl font-semibold text-text">
          {t('platform.notOperator')}
        </h1>
        <p className="text-sm text-text-secondary">{t('platform.notOperatorHint')}</p>
        <Button asChild className="self-start">
          <Link to="/overview">{t('platform.returnToWorkspace')}</Link>
        </Button>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-2xl p-6">
      <ErrorPanel error={me.error} onRetry={() => me.refetch()} retrying={me.isRefetching} />
    </main>
  );
}
