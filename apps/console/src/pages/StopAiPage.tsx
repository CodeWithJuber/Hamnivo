import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { CircleCheckIcon, OctagonPauseIcon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import { PageHeader, Section } from '../components/PageHeader';
import { QueryState } from '../components/States';
import { StopAiDialog } from '../components/StopAiDialog';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { killSwitchScope, useNames } from '../lib/names';
import { keys, useKillSwitches, useStudioMutation } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { KillSwitch } from '../lib/types';

function StopRow({ item, onClear }: { item: KillSwitch; onClear?: (item: KillSwitch) => void }) {
  const { t } = useTranslation();
  const { me } = useTenant();
  const names = useNames();
  const scope = killSwitchScope(t, names, item);
  const by =
    item.createdBy === me.current?.staffMemberId
      ? t('stopAi.you')
      : (names.member(item.createdBy) ?? t('stopAi.teammate'));
  return (
    <li
      data-testid="kill-switch"
      data-active={item.active ? 'true' : 'false'}
      className="flex flex-wrap items-start gap-4 rounded-lg border border-border p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={item.active ? 'danger' : 'neutral'}
            icon={
              item.active ? (
                <OctagonPauseIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <CircleCheckIcon className="size-3.5" aria-hidden="true" />
              )
            }
          >
            {item.active ? t('stopAi.status.active') : t('stopAi.status.cleared')}
          </StatusBadge>
          <span className="font-semibold text-text">{scope}</span>
        </div>
        <p className="text-text">
          <bdi>{t('shell.reason', { reason: item.reason })}</bdi>
        </p>
        <p className="text-text-secondary">
          {t('stopAi.columns.since')}: {formatDateTime(item.createdAt)} · {t('stopAi.columns.by')}:{' '}
          <bdi>{by}</bdi>
          {item.clearedAt ? (
            <>
              {' '}
              · {t('stopAi.columns.cleared')}: {formatDateTime(item.clearedAt)}
            </>
          ) : null}
        </p>
      </div>
      {item.active && onClear ? (
        <Button
          variant="secondary"
          onClick={() => onClear(item)}
          aria-label={t('stopAi.clearLabel', { scope })}
        >
          <PlayIcon className="rtl:-scale-x-100" aria-hidden="true" />
          {t('stopAi.clear')}
        </Button>
      ) : null}
    </li>
  );
}

/** Kill switches (X08, HNV-13-06): stop AI replies, see what is stopped and why, resume. */
export function StopAiPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const names = useNames();
  const switches = useKillSwitches();
  const [stopping, setStopping] = useState(false);
  const [clearing, setClearing] = useState<KillSwitch | null>(null);
  const clear = useStudioMutation(
    (id: string, tenant) =>
      api<KillSwitch>(`/v1/admin/kill-switches/${id}/clear`, { method: 'POST', tenant }),
    [keys.killSwitches],
  );
  const canAct = can('agents.publish');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('stopAi.title')}
        description={t('stopAi.description')}
        actions={
          canAct ? (
            <Button variant="destructive-solid" onClick={() => setStopping(true)}>
              <OctagonPauseIcon aria-hidden="true" />
              {t('stopAi.submit')}
            </Button>
          ) : null
        }
      />
      {!canAct ? <p className="text-sm text-text-secondary">{t('stopAi.noPermission')}</p> : null}
      <QueryState query={switches} label={t('stopAi.loading')} permitted={can('agents.read')}>
        {(data) => {
          const active = data.items.filter((s) => s.active);
          const past = data.items.filter((s) => !s.active);
          return (
            <>
              <Section id="stops-active" title={t('stopAi.active.title')}>
                {active.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-text-secondary">
                    <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
                    {t('stopAi.active.empty')}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3" data-testid="active-stops">
                    {active.map((item) => (
                      <StopRow
                        key={item.id}
                        item={item}
                        {...(canAct ? { onClear: setClearing } : {})}
                      />
                    ))}
                  </ul>
                )}
              </Section>
              <Section id="stops-past" title={t('stopAi.past.title')}>
                {past.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('stopAi.past.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-3" data-testid="past-stops">
                    {past.map((item) => (
                      <StopRow key={item.id} item={item} />
                    ))}
                  </ul>
                )}
              </Section>
            </>
          );
        }}
      </QueryState>
      {canAct ? <StopAiDialog open={stopping} onOpenChange={setStopping} /> : null}
      {clearing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setClearing(null);
          }}
          title={t('stopAi.clearTitle')}
          confirmLabel={t('stopAi.clearSubmit')}
          testId="clear-stop-dialog"
          fallbackFocus={() => document.getElementById('stops-active-title')}
          onConfirm={async () => {
            await clear.mutateAsync(clearing.id);
            announce(t('stopAi.cleared', { scope: killSwitchScope(t, names, clearing) }));
          }}
        >
          <p>{t('stopAi.clearBody', { scope: killSwitchScope(t, names, clearing) })}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
