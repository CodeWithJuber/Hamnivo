import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { Link, useSearch } from '@tanstack/react-router';
import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError, ErrorPanel, QueryState } from '../../components/States';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import {
  platformKeys,
  useMySupportGrants,
  usePlatformMutation,
  useSupportRead,
} from '../../lib/platform';
import type {
  PlatformOperator,
  SupportAudit,
  SupportConfiguration,
  SupportConversations,
  SupportGrant,
  SupportScope,
} from '../../lib/types';
import { GRANT_TONE } from './TenantsView';

function useMinutesLeft(until: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 60_000));
}

function Countdown({ until }: { until: string }) {
  const { t } = useTranslation();
  const minutes = useMinutesLeft(until);
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-text">
      <ClockIcon className="size-4" aria-hidden="true" />
      {t('platform.support.expiresIn', { minutes })}
      <span className="font-normal text-text-secondary">
        {t('platform.support.endsAt', { time: formatDateTime(until) })}
      </span>
    </p>
  );
}

function Configuration({ data }: { data: SupportConfiguration }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="support-configuration">
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-text">{t('platform.support.members')}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {data.members.map((m) => (
            <li key={m.email}>
              <bdi className="font-medium">{m.displayName}</bdi>{' '}
              <bdi dir="ltr" className="text-text-secondary">
                {m.email}
              </bdi>{' '}
              · {m.roles.join(', ') || '—'} · {m.status}
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-text">{t('platform.support.roles')}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {data.roles.map((r) => (
            <li key={r.name}>
              <bdi className="font-medium">{r.name}</bdi>{' '}
              <span dir="ltr" className="break-all text-text-secondary">
                {r.permissions.join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-text">{t('platform.support.brands')}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {data.brands.map((b) => (
            <li key={b.name}>
              <bdi className="font-medium">{b.name}</bdi> · {b.status} ·{' '}
              <span dir="ltr">{b.allowedOrigins.join(', ')}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold text-text">{t('platform.support.agents')}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {data.agents.map((a) => (
            <li key={a.name}>
              <bdi className="font-medium">{a.name}</bdi> ·{' '}
              {a.live ? t('platform.support.live') : t('platform.support.notLive')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Reading({ grant, area }: { grant: SupportGrant; area: SupportScope }) {
  const { t } = useTranslation();
  const read = useSupportRead(grant.id, area);
  if (read.error) {
    return (
      <ErrorPanel error={read.error} onRetry={() => read.refetch()} retrying={read.isRefetching} />
    );
  }
  if (!read.data) {
    return (
      <p aria-busy="true" className="text-sm text-text-secondary">
        {t('platform.support.reading', { area: t(`platform.support.view.${area}`) })}
      </p>
    );
  }
  if (area === 'configuration') return <Configuration data={read.data as SupportConfiguration} />;
  if (area === 'conversations') {
    const data = read.data as SupportConversations;
    return (
      <div className="flex flex-col gap-2" data-testid="support-conversations">
        <p className="text-sm text-text-secondary">{t('platform.support.conversationsNote')}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {data.items.map((c) => (
            <li key={c.id}>
              <code dir="ltr">{c.id}</code> · {c.status} · {c.ownerMode} ·{' '}
              {formatDateTime(c.lastActivityAt)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const data = read.data as SupportAudit;
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="support-audit">
      {data.items.map((e) => (
        <li key={e.id}>
          {formatDateTime(e.occurredAt)} · <code dir="ltr">{e.action}</code> · {e.outcome}
        </li>
      ))}
    </ul>
  );
}

function GrantCard({ grant }: { grant: SupportGrant }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const search = useSearch({ from: '/platform' });
  const end = usePlatformMutation(
    (id: string) => api<SupportGrant>(`/v1/platform/support-grants/${id}/end`, { method: 'POST' }),
    [platformKeys.grants, platformKeys.overview],
  );
  const active = grant.state === 'active';
  const reading = search.grant === grant.id && search.area ? search.area : null;
  return (
    <li
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
      data-testid="my-support-grant"
      data-state={grant.state}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-semibold text-text">
            <bdi>{grant.tenant.name}</bdi>
          </h3>
          <p className="text-sm text-text-secondary">
            {t('access.security.support.asked', { time: formatDateTime(grant.requestedAt) })}
          </p>
        </div>
        <StatusBadge tone={GRANT_TONE[grant.state]}>
          {t(`access.security.support.states.${grant.state}`)}
        </StatusBadge>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text">
        {grant.scopes.map((scope) => (
          <li key={scope}>{t(`access.security.support.scopes.${scope}`)}</li>
        ))}
      </ul>
      {grant.decidedBy ? (
        <p className="text-sm text-text-secondary">
          {t(
            grant.state === 'declined'
              ? 'platform.support.declinedBy'
              : 'platform.support.approvedBy',
            {
              name: grant.decidedBy.displayName,
            },
          )}
        </p>
      ) : null}
      {grant.decisionNote ? (
        <p className="text-sm text-text">
          <bdi>{t('platform.support.note', { note: grant.decisionNote })}</bdi>
        </p>
      ) : null}
      {active ? (
        <div className="flex flex-col gap-3 rounded-lg border border-info/30 bg-info-subtle p-3">
          <Countdown until={grant.expiresAt} />
          <div className="flex flex-wrap gap-2">
            {grant.scopes.map((scope) => (
              <Button key={scope} asChild variant="secondary" size="sm">
                <Link
                  to="/platform"
                  search={{ view: 'support', grant: grant.id, area: scope }}
                  data-testid={`read-${scope}`}
                >
                  {t(`platform.support.view.${scope}`)}
                </Link>
              </Button>
            ))}
            <Button
              variant="destructive"
              size="sm"
              busy={end.isPending}
              data-testid="end-support"
              onClick={async () => {
                try {
                  await end.mutateAsync(grant.id);
                  announce(t('platform.support.ended'));
                } catch {
                  // Shown below.
                }
              }}
            >
              {t('platform.support.end')}
            </Button>
          </div>
        </div>
      ) : null}
      <ActionError error={end.error} />
      {active && reading ? <Reading grant={grant} area={reading} /> : null}
      {grant.state === 'declined' || grant.state === 'expired' ? (
        <Button asChild variant="secondary" size="sm" className="self-start">
          <Link to="/platform" search={{ tenant: grant.tenant.id }}>
            {t('platform.support.requestAgain')}
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

/** The operator's support access (A18): requests, time left, reads and ending early. */
export function SupportView({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const grants = useMySupportGrants(operator.permissions.includes('platform.support.request'));
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-text-secondary">{t('platform.support.intro')}</p>
      <QueryState
        query={grants}
        label={t('platform.support.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('platform.support.none')}</p>}
      >
        {(data) => (
          <ul className="flex flex-col gap-3">
            {data.items.map((grant) => (
              <GrantCard key={grant.id} grant={grant} />
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
