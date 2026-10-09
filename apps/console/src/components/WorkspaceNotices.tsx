import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon, HeadsetIcon, InfoIcon, OctagonAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceNotices } from '../lib/access';
import { formatDateTime } from '../lib/format';
import { useTenant } from '../lib/tenant';
import type { IncidentNotice, WorkspaceNotices as Notices } from '../lib/types';

const INCIDENT_STYLE: Record<IncidentNotice['severity'], { box: string; icon: typeof InfoIcon }> = {
  notice: { box: 'border-info/30 bg-info-subtle', icon: InfoIcon },
  degraded: { box: 'border-warning/40 bg-warning-subtle', icon: AlertTriangleIcon },
  outage: { box: 'border-danger/30 bg-danger-subtle', icon: OctagonAlertIcon },
};

/**
 * Email, WhatsApp or Telegram channels that have not worked for 15 minutes (A11), for people who
 * manage integrations: one is named with what Chatwoot says; several are listed. "Fix it" opens
 * Channels on the (first) channel's brand.
 */
function ChannelsDown({ channels }: { channels: Notices['unhealthyChannels'] }) {
  const { t } = useTranslation();
  const [first] = channels;
  if (!first) return null;
  const words = (channel: typeof first) => ({
    channel: t(`channels.kind.${channel.kind}`),
    brand: channel.brandName,
    time: formatDateTime(channel.since),
  });
  return (
    <div
      data-testid="channel-down-banner"
      className="flex flex-wrap items-start gap-3 border-b border-warning/40 bg-warning-subtle px-4 py-3 sm:px-6 lg:px-8"
    >
      <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-text" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        {channels.length === 1 ? (
          <>
            <p className="font-medium text-text">{t('access.notices.channelDown', words(first))}</p>
            <p className="text-text-secondary">
              <bdi>{first.name}</bdi>
              {first.address ? (
                <>
                  {' · '}
                  <bdi dir="ltr" className="break-all">
                    {first.address}
                  </bdi>
                </>
              ) : null}
            </p>
            {first.problem ? (
              <p className="text-text-secondary">
                {t('channels.problem', { problem: first.problem })}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="font-medium text-text">
              {t('access.notices.channelsDown', { n: channels.length })}
            </p>
            <ul className="flex flex-col gap-0.5 text-text-secondary">
              {channels.map((channel) => (
                <li key={channel.id}>{t('access.notices.channelItem', words(channel))}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Button asChild variant="secondary" size="sm">
        <Link to="/channels" search={{ brand: first.brandId }}>
          {t('access.notices.fixChannel')}
        </Link>
      </Button>
    </div>
  );
}

/**
 * Banners every member sees (A17, A18): Hamnivo support reading this workspace right now, a
 * request waiting for an owner, and platform incidents. People who manage integrations also see
 * channels that stopped working.
 */
export function WorkspaceNotices() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const notices = useWorkspaceNotices();
  const data = notices.data;
  if (!data) return null;
  const pending = can('support.grant') ? data.pendingSupportRequests : 0;
  if (
    data.supportAccess.length === 0 &&
    pending === 0 &&
    data.incidents.length === 0 &&
    data.unhealthyChannels.length === 0
  )
    return null;
  return (
    <section aria-label={t('access.notices.label')} className="flex flex-col" data-testid="notices">
      {data.incidents.map((incident) => {
        const style = INCIDENT_STYLE[incident.severity];
        return (
          <div
            key={incident.id}
            data-testid="incident-banner"
            data-severity={incident.severity}
            className={`flex flex-wrap items-start gap-3 border-b px-4 py-3 sm:px-6 lg:px-8 ${style.box}`}
          >
            <style.icon className="mt-0.5 size-5 shrink-0 text-text" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <p className="font-semibold text-text">
                {t(`access.notices.incident.${incident.severity}`)}: <bdi>{incident.title}</bdi>
              </p>
              <p className="text-text">
                <bdi>{incident.message}</bdi>
              </p>
              <p className="text-text-secondary">
                {t('access.notices.since', { time: formatDateTime(incident.startedAt) })}
              </p>
            </div>
          </div>
        );
      })}
      {data.supportAccess.map((grant) => (
        <div
          key={grant.id}
          data-testid="support-banner"
          className="flex flex-wrap items-start gap-3 border-b border-info/30 bg-info-subtle px-4 py-3 sm:px-6 lg:px-8"
        >
          <HeadsetIcon className="mt-0.5 size-5 shrink-0 text-text" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <p className="font-medium text-text">
              {t('access.notices.supportActive', {
                name: grant.operatorName,
                areas: grant.scopes
                  .map((scope) => t(`access.security.support.scopes.${scope}`))
                  .join('; '),
                time: formatDateTime(grant.expiresAt),
              })}
            </p>
            <p className="text-text-secondary">{t('access.notices.supportRecorded')}</p>
          </div>
          {can('support.grant') ? (
            <Button asChild variant="secondary" size="sm">
              <Link to="/security" hash="support-access-title">
                {t('access.notices.review')}
              </Link>
            </Button>
          ) : null}
        </div>
      ))}
      {pending > 0 ? (
        <div
          data-testid="support-pending-banner"
          className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning-subtle px-4 py-3 sm:px-6 lg:px-8"
        >
          <HeadsetIcon className="size-5 shrink-0 text-text" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm font-medium text-text">
            {t('access.notices.supportPending', { n: pending })}
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to="/security" hash="support-access-title">
              {t('access.notices.reviewRequest')}
            </Link>
          </Button>
        </div>
      ) : null}
      <ChannelsDown channels={data.unhealthyChannels} />
    </section>
  );
}
