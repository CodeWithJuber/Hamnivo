import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon, CircleCheckIcon, OctagonPauseIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GoLiveNotices } from '../components/agent/GoLiveNotices';
import { AgentBadge, ConnectionBadge, OutcomeBadge } from '../components/Badges';
import { InstallBadge } from '../components/InstallStatus';
import { PageHeader, Section } from '../components/PageHeader';
import { QueryState } from '../components/States';
import { formatDate, formatDateTime, formatDuration, formatRelative } from '../lib/format';
import { isStaffOnly } from '../lib/home';
import { killSwitchScope, useBrandRefs, useNames } from '../lib/names';
import { useAgents, useAuthorityConnections, useKillSwitches, useRuns } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Agent, AuthorityConnection } from '../lib/types';
import { AssistantReadiness } from './home/AssistantReadiness';
import { GetSetUp } from './home/GetSetUp';
import { YourChats } from './home/YourChats';

/** Chat connection of a brand: an authority connection with a live inbox for it. */
export function connectionFor(
  connections: AuthorityConnection[] | undefined,
  brandId: string,
): AuthorityConnection | undefined {
  return connections?.find((c) =>
    c.inboxes.some((inbox) => inbox.brandId === brandId && inbox.purpose === 'live'),
  );
}

/** The agent that answers a brand: its default, or the only one it has. */
export function agentFor(agents: Agent[] | undefined, brandId: string): Agent | undefined {
  const own = (agents ?? []).filter((a) => a.brandId === brandId && a.status === 'active');
  return own.find((a) => a.isDefault) ?? own[0];
}

/*
 * Placeholders in the shape of what loads into them (HNV-03-03), so nothing jumps when it arrives:
 * a brand row with its name, three labelled badges and two buttons; a run with its outcome, agent,
 * duration and time; the one line that says whether the AI is stopped.
 */
function BrandRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="brands-skeleton">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-6 gap-y-3 py-3">
          <Skeleton className="h-4 min-w-40 flex-1" />
          {[0, 1, 2].map((column) => (
            <span key={column} className="flex flex-col gap-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </span>
          ))}
          <span className="flex gap-2">
            <Skeleton className="h-9 w-20 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RunsSkeleton() {
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="runs-skeleton">
      {[0, 1, 2, 3, 4].map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-3 min-w-24 flex-1" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-16" />
        </li>
      ))}
    </ul>
  );
}

function StopsSkeleton() {
  return (
    <div className="flex items-center gap-2" data-testid="stops-skeleton">
      <Skeleton className="size-4 rounded-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
    </div>
  );
}

/**
 * Part of Home failed to load or to refresh (HNV-03-04). The cards keep their own notices and
 * retries; this says the rest of Studio, the inbox included, still works, with a way there.
 */
function DegradedNotice() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const brands = useBrandRefs();
  const switches = useKillSwitches();
  const runs = useRuns({}, 5);
  const failed =
    (brands.permitted && Boolean(brands.error ?? brands.refreshError)) ||
    (can('agents.read') && Boolean(switches.error)) ||
    (can('analytics.read') && Boolean(runs.error));
  if (!failed) return null;
  return (
    <section
      role="status"
      aria-labelledby="overview-degraded-title"
      data-testid="overview-degraded"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-4"
    >
      <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <h2 id="overview-degraded-title" className="font-semibold text-text">
          {t('overview.degraded.title')}
        </h2>
        <p className="text-text-secondary">{t('overview.degraded.description')}</p>
      </div>
      {can('conversations.read') ? (
        <Button asChild variant="secondary" size="sm">
          <Link to="/inbox">{t('overview.chats.open')}</Link>
        </Button>
      ) : null}
    </section>
  );
}

function BrandsSection() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const brands = useBrandRefs();
  const connections = useAuthorityConnections();
  const agents = useAgents();
  return (
    <Section
      id="overview-brands"
      title={t('overview.brands.title')}
      description={t('overview.brands.description')}
    >
      <QueryState
        query={{
          data: brands.items,
          error: brands.error ?? brands.refreshError,
          isPending: brands.pending,
          isRefetching: brands.isRefetching,
          refetch: brands.refetch,
          dataUpdatedAt: brands.dataUpdatedAt,
        }}
        label={t('overview.brands.loading')}
        skeleton={<BrandRowsSkeleton />}
        staleNotice
        permitted={brands.permitted}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('overview.brands.empty.title')}
            description={t('overview.brands.empty.description')}
            action={
              can('brands.manage') ? (
                <Button asChild>
                  <Link to="/brands">{t('overview.brands.empty.action')}</Link>
                </Button>
              ) : (
                <span />
              )
            }
          />
        }
      >
        {(items) => (
          <ul className="flex flex-col divide-y divide-border" data-testid="overview-brands">
            {items.map((brand) => {
              const connection = connectionFor(connections.data?.items, brand.id);
              const agent = agentFor(agents.data?.items, brand.id);
              return (
                <li
                  key={brand.id}
                  className="flex flex-wrap items-center gap-x-6 gap-y-3 py-3"
                  data-brand={brand.name}
                >
                  <span className="min-w-40 flex-1 font-medium text-text">
                    <bdi>{brand.name}</bdi>
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="text-xs text-text-secondary">
                      {t('overview.brands.columns.chat')}
                    </span>
                    {connections.data ? (
                      <ConnectionBadge status={connection?.status ?? 'none'} />
                    ) : can('integrations.manage') && connections.isPending ? (
                      <Skeleton className="h-6 w-24 rounded-full" />
                    ) : (
                      <span
                        className="text-xs text-text-muted"
                        title={t('brands.chat.statusHidden')}
                      >
                        —
                      </span>
                    )}
                  </span>
                  {can('brands.manage') ? (
                    <span className="flex flex-col gap-1">
                      <span className="text-xs text-text-secondary">
                        {t('setup.onboarding.install.status.onWebsite')}
                      </span>
                      <InstallBadge brandId={brand.id} />
                    </span>
                  ) : null}
                  <span className="flex flex-col gap-1">
                    <span className="text-xs text-text-secondary">
                      {t('overview.brands.columns.ai')}
                    </span>
                    {can('agents.read') ? (
                      <AgentBadge agent={agent} />
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    {can('brands.manage') ? (
                      <Button asChild variant="secondary" size="sm">
                        <Link to="/brands" hash={`brand-${brand.id}`}>
                          {t('overview.brands.install')}
                        </Link>
                      </Button>
                    ) : null}
                    {agent ? (
                      <Button asChild variant="secondary" size="sm">
                        <Link to="/agents/$agentId" params={{ agentId: agent.id }}>
                          {t('overview.brands.openAgent')}
                        </Link>
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

function StopsSection() {
  const { t } = useTranslation();
  const switches = useKillSwitches();
  const names = useNames();
  return (
    <Section
      id="overview-stops"
      title={t('overview.stops.title')}
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link to="/stop-ai">{t('overview.stops.manage')}</Link>
        </Button>
      }
    >
      <QueryState
        query={switches}
        label={t('overview.stops.loading')}
        skeleton={<StopsSkeleton />}
        staleNotice
      >
        {(data) => {
          const active = data.items.filter((s) => s.active);
          if (active.length === 0) {
            return (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
                {t('overview.stops.none')}
              </p>
            );
          }
          return (
            <ul className="flex flex-col gap-2" data-testid="overview-stops">
              {active.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-3"
                >
                  <OctagonPauseIcon className="mt-0.5 size-5 text-danger" aria-hidden="true" />
                  <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                    <span className="font-semibold text-text">
                      {killSwitchScope(t, names, item)}
                    </span>
                    <bdi className="text-text">{t('shell.reason', { reason: item.reason })}</bdi>
                    <span className="text-text-secondary">
                      {t('shell.since', { time: formatDateTime(item.createdAt) })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </QueryState>
    </Section>
  );
}

function RunsSection() {
  const { t } = useTranslation();
  const runs = useRuns({}, 5);
  const names = useNames();
  const first = runs.data?.pages[0];
  return (
    <Section
      id="overview-runs"
      title={t('overview.runs.title')}
      description={t('overview.runs.description')}
      actions={
        <Button asChild variant="secondary" size="sm">
          <Link to="/runs">{t('overview.runs.viewAll')}</Link>
        </Button>
      }
    >
      <QueryState
        query={{ ...runs, data: first }}
        label={t('overview.runs.loading')}
        skeleton={<RunsSkeleton />}
        staleNotice
        isEmpty={(page) => page.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('overview.runs.empty.title')}
            description={t('overview.runs.empty.description')}
            action={
              <Button asChild variant="secondary">
                <Link to="/agents">{t('runs.empty.action')}</Link>
              </Button>
            }
          />
        }
      >
        {(page) => (
          <ul className="flex flex-col divide-y divide-border" data-testid="overview-runs">
            {page.items.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <OutcomeBadge run={run} />
                <span className="min-w-0 flex-1 text-text">
                  <bdi>{names.agent(run.agentId) ?? t('runs.detail.noAgent')}</bdi>
                  {run.agentVersion ? (
                    <span className="text-text-secondary">
                      {' '}
                      {t('runs.detail.version', { version: run.agentVersion })}
                    </span>
                  ) : null}
                </span>
                <span className="text-text-secondary">{formatDuration(run.latencyMs)}</span>
                <time dateTime={run.startedAt} className="text-text-secondary">
                  {formatRelative(run.startedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

/**
 * Home, the workspace overview (board 03: HNV-03-01 healthy, 03-02 empty, 03-03 loading, 03-04
 * partial). Staff who do not run the workspace start with their chats; people who do start with
 * what is left to set up. What is below is the same for everyone.
 */
export function OverviewPage() {
  const { t } = useTranslation();
  const { me, can } = useTenant();
  const staffOnly = isStaffOnly(can);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('overview.title')}
        description={
          <>
            {t('overview.greeting', { name: me.user.name })}{' '}
            <time dateTime={new Date().toISOString().slice(0, 10)}>{formatDate(new Date())}</time>
          </>
        }
      />
      <DegradedNotice />
      {staffOnly && can('conversations.read') ? <YourChats /> : null}
      <GoLiveNotices />
      <GetSetUp />
      <AssistantReadiness />
      {can('agents.read') ? <StopsSection /> : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <BrandsSection />
        {can('analytics.read') ? <RunsSection /> : null}
      </div>
    </div>
  );
}
