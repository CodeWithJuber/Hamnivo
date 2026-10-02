import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { PlusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { SelectField, TextareaField, TextField } from '../../components/Fields';
import { ActionError, QueryState } from '../../components/States';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { platformKeys, useIncidents, usePlatformMutation } from '../../lib/platform';
import type { Incident, PlatformOperator } from '../../lib/types';

const TONE: Record<Incident['severity'], StatusTone> = {
  notice: 'info',
  degraded: 'warning',
  outage: 'danger',
};
const SEVERITIES: Incident['severity'][] = ['notice', 'degraded', 'outage'];

function DeclareDialog({
  onOpenChange,
  onDone,
}: {
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<Incident['severity']>('degraded');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const declare = usePlatformMutation(
    (body: Record<string, unknown>) =>
      api<Incident>('/v1/platform/incidents', { method: 'POST', body }),
    [platformKeys.incidents, platformKeys.overview],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (title.trim().length < 3) next.title = t('platform.incidents.tooShort');
    if (message.trim().length < 3) next.message = t('platform.incidents.tooShort');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await declare.mutateAsync({ title: title.trim(), message: message.trim(), severity });
      onDone(t('platform.incidents.posted'));
      onOpenChange(false);
    } catch {
      // Shown in the dialog.
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!declare.isPending) onOpenChange(open);
      }}
      title={t('platform.incidents.declare')}
      description={t('platform.incidents.intro')}
      testId="declare-incident-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={Object.entries(errors).map(([field, text]) => ({
            fieldId: `incident-${field}`,
            message: text,
          }))}
        />
        <TextField
          id="incident-title"
          label={t('platform.incidents.titleField')}
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          error={errors.title}
        />
        <TextareaField
          id="incident-message"
          label={t('platform.incidents.message')}
          hint={t('platform.incidents.messageHint')}
          value={message}
          rows={3}
          maxLength={600}
          onChange={(event) => setMessage(event.target.value)}
          error={errors.message}
        />
        <SelectField
          id="incident-severity"
          label={t('platform.incidents.severity')}
          value={severity}
          onChange={(event) => setSeverity(event.target.value as Incident['severity'])}
          options={SEVERITIES.map((s) => ({
            value: s,
            label: t(`platform.incidents.severities.${s}`),
          }))}
        />
        <ActionError error={declare.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={declare.isPending} data-testid="post-incident">
            {t('platform.incidents.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Incidents (A17): posted as a banner in every workspace until resolved. */
export function IncidentsView({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const incidents = useIncidents(true);
  const [declaring, setDeclaring] = useState(false);
  const [resolving, setResolving] = useState<Incident | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = operator.permissions.includes('platform.incidents.manage');
  const resolve = usePlatformMutation(
    (id: string) => api<Incident>(`/v1/platform/incidents/${id}/resolve`, { method: 'POST' }),
    [platformKeys.incidents, platformKeys.overview],
  );
  const done = (message: string) => {
    setNotice(message);
    announce(message);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-text-secondary">{t('platform.incidents.intro')}</p>
        {canManage ? (
          <Button onClick={() => setDeclaring(true)} data-testid="declare-incident">
            <PlusIcon aria-hidden="true" />
            {t('platform.incidents.declare')}
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="text-sm text-text">
          {notice}
        </p>
      ) : null}
      <QueryState
        query={incidents}
        label={t('platform.incidents.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('platform.incidents.none')}</p>}
      >
        {(data) => (
          <ul className="flex flex-col gap-3" data-testid="incidents">
            {data.items.map((incident) => (
              <li
                key={incident.id}
                data-incident-status={incident.status}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-text">
                    <bdi>{incident.title}</bdi>
                  </h3>
                  <StatusBadge tone={TONE[incident.severity]}>
                    {t(`platform.incidents.severities.${incident.severity}`)}
                  </StatusBadge>
                  {incident.status === 'active' ? (
                    <StatusBadge tone="info">{t('platform.incidents.active')}</StatusBadge>
                  ) : null}
                </div>
                <p className="text-sm text-text">
                  <bdi>{incident.message}</bdi>
                </p>
                <p className="text-sm text-text-secondary">
                  {t('platform.incidents.started', { time: formatDateTime(incident.startedAt) })}
                  {incident.resolvedAt
                    ? ` · ${t('platform.incidents.resolved', { time: formatDateTime(incident.resolvedAt) })}`
                    : ''}
                </p>
                {canManage && incident.status === 'active' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    onClick={() => setResolving(incident)}
                    data-testid="resolve-incident"
                  >
                    {t('platform.incidents.resolve')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {declaring ? <DeclareDialog onOpenChange={setDeclaring} onDone={done} /> : null}
      {resolving ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setResolving(null);
          }}
          title={t('platform.incidents.resolve')}
          confirmLabel={t('platform.incidents.resolve')}
          onConfirm={async () => {
            await resolve.mutateAsync(resolving.id);
            done(t('platform.incidents.resolvedDone'));
          }}
        >
          <p>
            <bdi>{resolving.title}</bdi>
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
