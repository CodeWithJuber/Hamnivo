import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { HeadsetIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { accessKeys, useSupportGrants } from '../../lib/access';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { SupportGrant, SupportScope } from '../../lib/types';

const STATE_TONE: Record<SupportGrant['state'], StatusTone> = {
  pending: 'warning',
  active: 'info',
  declined: 'neutral',
  revoked: 'neutral',
  ended: 'neutral',
  expired: 'neutral',
};

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440];

function useInvalidate() {
  return [accessKeys.supportGrants, accessKeys.notices, accessKeys.audit];
}

/** A pending request: approve it as asked or narrower and shorter, or decline it. */
function PendingRequest({
  grant,
  onDone,
}: {
  grant: SupportGrant;
  onDone: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [scopes, setScopes] = useState<SupportScope[]>(grant.scopes);
  const [minutes, setMinutes] = useState(grant.durationMinutes);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const approve = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<SupportGrant>(`/v1/admin/support-grants/${grant.id}/approve`, {
        method: 'POST',
        body,
        tenant,
      }),
    invalidate,
  );
  const decline = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<SupportGrant>(`/v1/admin/support-grants/${grant.id}/decline`, {
        method: 'POST',
        body,
        tenant,
      }),
    invalidate,
  );
  const prefix = `support-${grant.id}`;
  const failure = approve.error ?? decline.error;
  return (
    <li
      className="flex flex-col gap-4 rounded-lg border border-warning/40 bg-surface p-4"
      data-testid="support-request"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold text-text">
            {t('access.security.support.from', { name: grant.operator.name })}
          </p>
          <p className="text-sm text-text-secondary">
            {t('access.security.support.asked', { time: formatDateTime(grant.requestedAt) })}
          </p>
        </div>
        <StatusBadge tone="warning">{t('access.security.support.states.pending')}</StatusBadge>
      </div>
      <p className="text-sm text-text">
        <bdi>{t('access.security.support.reason', { reason: grant.reason })}</bdi>
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text">
          {t('access.security.support.areas')}
        </legend>
        {grant.scopes.map((scope) => (
          <CheckboxField
            key={scope}
            id={`${prefix}-${scope}`}
            label={t(`access.security.support.scopes.${scope}`)}
            checked={scopes.includes(scope)}
            onCheckedChange={(checked) =>
              setScopes((current) =>
                checked ? [...current, scope] : current.filter((s) => s !== scope),
              )
            }
          />
        ))}
      </fieldset>
      <SelectField
        id={`${prefix}-minutes`}
        label={t('access.security.support.minutes')}
        value={String(minutes)}
        onChange={(event) => setMinutes(Number(event.target.value))}
        options={DURATIONS.filter((d) => d <= grant.durationMinutes)
          .concat(DURATIONS.includes(grant.durationMinutes) ? [] : [grant.durationMinutes])
          .sort((a, b) => a - b)
          .map((d) => ({
            value: String(d),
            label: t('access.security.support.duration', { minutes: d }),
          }))}
      />
      <TextField
        id={`${prefix}-note`}
        label={t('access.security.support.note')}
        labelNote={t('app.optional')}
        value={note}
        maxLength={400}
        onChange={(event) => setNote(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ActionError error={isCancelled(failure) ? null : failure} />
      <div className="flex flex-wrap gap-2">
        <Button
          busy={approve.isPending}
          disabled={decline.isPending}
          data-testid="approve-support"
          onClick={async () => {
            if (scopes.length === 0) {
              setError(t('access.security.support.pickArea'));
              return;
            }
            setError(null);
            try {
              const approved = await approve.mutateAsync({
                scopes,
                durationMinutes: minutes,
                ...(note.trim() ? { note: note.trim() } : {}),
              });
              onDone(
                t('access.security.support.approved', {
                  time: formatDateTime(approved.expiresAt),
                }),
              );
            } catch {
              // Shown above.
            }
          }}
        >
          {t('access.security.support.approve')}
        </Button>
        <Button
          variant="secondary"
          busy={decline.isPending}
          disabled={approve.isPending}
          data-testid="decline-support"
          onClick={async () => {
            try {
              await decline.mutateAsync(note.trim() ? { note: note.trim() } : {});
              onDone(t('access.security.support.declined'));
            } catch {
              // Shown above.
            }
          }}
        >
          {t('access.security.support.decline')}
        </Button>
      </div>
    </li>
  );
}

function ActiveGrant({ grant, onDone }: { grant: SupportGrant; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState(false);
  const revoke = useStudioMutation(
    (_: undefined, tenant) =>
      api<SupportGrant>(`/v1/admin/support-grants/${grant.id}/revoke`, {
        method: 'POST',
        body: {},
        tenant,
      }),
    useInvalidate(),
  );
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-info/40 bg-info-subtle p-4"
      data-testid="support-active"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold text-text">
          {t('access.security.support.from', { name: grant.operator.name })}
        </p>
        <StatusBadge tone="info">{t('access.security.support.states.active')}</StatusBadge>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text">
        {grant.scopes.map((scope) => (
          <li key={scope}>{t(`access.security.support.scopes.${scope}`)}</li>
        ))}
      </ul>
      <p className="text-sm text-text">
        {t('access.security.support.endsAt', { time: formatDateTime(grant.expiresAt) })}
      </p>
      <Button
        variant="destructive"
        className="self-start"
        onClick={() => setRevoking(true)}
        data-testid="revoke-support"
      >
        {t('access.security.support.revoke')}
      </Button>
      {revoking ? (
        <ConfirmDialog
          open
          onOpenChange={setRevoking}
          title={t('access.security.support.revokeTitle')}
          confirmLabel={t('access.security.support.revoke')}
          variant="destructive-solid"
          onConfirm={async () => {
            await revoke.mutateAsync(undefined);
            onDone(t('access.security.support.revoked'));
          }}
        >
          <p>{t('access.security.support.revokeBody')}</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

/** Support access (A18): requests from Hamnivo support, decided by the workspace's owners. */
export function SupportSection() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const grants = useSupportGrants();
  const [notice, setNotice] = useState<string | null>(null);
  const done = (text: string) => {
    setNotice(text);
    announce(text);
  };
  return (
    <Section
      id="support-access"
      title={t('access.security.support.title')}
      description={t('access.security.support.description')}
    >
      <QueryState
        query={grants}
        label={t('access.security.support.loading')}
        permitted={can('support.grant')}
        forbidden={
          <p className="text-sm text-text-secondary">{t('access.security.support.forbidden')}</p>
        }
      >
        {(data) => {
          const pending = data.items.filter((g) => g.state === 'pending');
          const active = data.items.filter((g) => g.state === 'active');
          const past = data.items.filter((g) => g.state !== 'pending' && g.state !== 'active');
          return (
            <div className="flex flex-col gap-6">
              {notice ? (
                <p role="status" className="text-sm text-text" data-testid="support-notice">
                  {notice}
                </p>
              ) : null}
              {data.items.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-text-secondary">
                  <HeadsetIcon className="size-4" aria-hidden="true" />
                  {t('access.security.support.none')}
                </p>
              ) : null}
              {pending.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <h3 className="font-semibold text-text">
                    {t('access.security.support.pending')}
                  </h3>
                  <ul className="flex flex-col gap-3">
                    {pending.map((grant) => (
                      <PendingRequest key={grant.id} grant={grant} onDone={done} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {active.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <h3 className="font-semibold text-text">{t('access.security.support.active')}</h3>
                  <ul className="flex flex-col gap-3">
                    {active.map((grant) => (
                      <ActiveGrant key={grant.id} grant={grant} onDone={done} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {past.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <h3 className="font-semibold text-text">
                    {t('access.security.support.history')}
                  </h3>
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {past.map((grant) => (
                      <li
                        key={grant.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm"
                        data-state={grant.state}
                      >
                        <span className="font-medium text-text">
                          <bdi>{grant.operator.name}</bdi>
                        </span>
                        <span className="text-text-secondary">
                          {t('access.security.support.asked', {
                            time: formatDateTime(grant.requestedAt),
                          })}
                        </span>
                        <StatusBadge tone={STATE_TONE[grant.state]} className="ms-auto">
                          {t(`access.security.support.states.${grant.state}`)}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        }}
      </QueryState>
    </Section>
  );
}
