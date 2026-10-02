import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { useTranslation } from 'react-i18next';
import { QueryState } from '../../components/States';
import { formatDateTime, formatNumber } from '../../lib/format';
import { usePlatformHealth } from '../../lib/platform';
import type { PlatformHealth } from '../../lib/types';

const TONE: Record<PlatformHealth['services'][number]['state'], StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
};

/** Service health (A17): the services, background delivery, connectors and platform keys. */
export function HealthView() {
  const { t } = useTranslation();
  const health = usePlatformHealth(true);
  return (
    <QueryState query={health} label={t('platform.health.loading')}>
      {(data) => (
        <div className="flex flex-col gap-5" data-testid="platform-health">
          <p className="text-sm text-text-secondary">
            {t('platform.health.checked', { time: formatDateTime(data.checkedAt) })}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {data.services.map((service) => (
              <li
                key={service.key}
                data-service={service.key}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
              >
                <span className="font-medium text-text">
                  {t(`platform.health.services.${service.key}`)}
                </span>
                <StatusBadge tone={TONE[service.state]}>
                  {t(`platform.health.states.${service.state}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1 text-sm text-text">
            <p>
              {t('platform.health.queue', {
                pending: formatNumber(data.queue.pending),
                failing: formatNumber(data.queue.failing),
              })}
            </p>
            {data.queue.oldestSeconds !== null ? (
              <p>
                {t('platform.health.oldest', { seconds: formatNumber(data.queue.oldestSeconds) })}
              </p>
            ) : null}
            <p>
              {t('platform.health.connectors', {
                total: formatNumber(data.connectors.total),
                degraded: formatNumber(data.connectors.degraded),
                disabled: formatNumber(data.connectors.disabled),
              })}
            </p>
          </div>
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-text">{t('platform.health.providers')}</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {data.providers.map((p) => (
                <li key={p.provider} className="flex items-center gap-2">
                  <span className="text-text">{p.provider}</span>
                  <StatusBadge tone={p.configured ? 'success' : 'neutral'}>
                    {p.configured
                      ? t('platform.health.configured')
                      : t('platform.health.notConfigured')}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </QueryState>
  );
}
