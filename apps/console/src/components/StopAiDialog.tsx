import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { OctagonPauseIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, newIdempotencyKey } from '../lib/api';
import { killSwitchScope, useBrandRefs, useNames } from '../lib/names';
import { keys, useAgents, useStudioMutation } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import type { KillSwitch, KillSwitchScope } from '../lib/types';
import { AppDialog, DialogFooter } from './AppDialog';
import { ChoiceField, SelectField, TextareaField } from './Fields';
import { ActionError } from './States';

export interface StopTarget {
  scope: KillSwitchScope;
  targetId?: string;
}

/**
 * Stop AI replies for the tenant, one brand or one agent, with a reason people can see
 * (HNV-13-06, HNV-11-06). The gateway may ask for a fresh sign-in first.
 */
export function StopAiDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: StopTarget | undefined;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const names = useNames();
  const brands = useBrandRefs();
  const agents = useAgents();
  const [scope, setScope] = useState<KillSwitchScope>(initial?.scope ?? 'tenant');
  const [targetId, setTargetId] = useState(initial?.targetId ?? '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  // Each opening is a new request: fresh fields and a fresh idempotency key.
  useEffect(() => {
    if (!open) return;
    setScope(initial?.scope ?? 'tenant');
    setTargetId(initial?.targetId ?? '');
    setReason('');
    setErrors({});
    setAttempted(false);
    setCancelled(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open, initial?.scope, initial?.targetId]);

  const stop = useStudioMutation(
    (body: { scope: KillSwitchScope; targetId?: string; reason: string }, tenant) =>
      api<KillSwitch>('/v1/admin/kill-switches', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      }),
    [keys.killSwitches],
  );

  const targets =
    scope === 'brand'
      ? (brands.items ?? []).map((b) => ({ value: b.id, label: b.name }))
      : (agents.data?.items ?? [])
          .filter((a) => a.status === 'active')
          .map((a) => ({
            value: a.id,
            label: `${a.name} (${names.brand(a.brandId) ?? a.brandId})`,
          }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (scope !== 'tenant' && !targetId) next.target = t('stopAi.errors.target');
    if (reason.trim().length < 3) next.reason = t('stopAi.errors.reason');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setCancelled(false);
    const body = {
      scope,
      reason: reason.trim(),
      ...(scope === 'tenant' ? {} : { targetId }),
    };
    try {
      const created = await stop.mutateAsync(body);
      const where = killSwitchScope(t, names, created);
      announce(t('stopAi.stopped', { scope: where }), 'assertive');
      onOpenChange(false);
    } catch (error) {
      if (isCancelled(error)) setCancelled(true);
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `stop-${field}`, message }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!stop.isPending) onOpenChange(next);
      }}
      title={t('stopAi.dialogTitle')}
      description={t('stopAi.dialogDescription')}
      testId="stop-ai-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <ChoiceField
          id="stop-scope"
          legend={t('stopAi.scope')}
          value={scope}
          onValueChange={(value) => {
            setScope(value as KillSwitchScope);
            setTargetId('');
          }}
          choices={(['tenant', 'brand', 'agent'] as const).map((value) => ({
            value,
            label: t(`stopAi.scopes.${value}`),
          }))}
        />
        {scope !== 'tenant' ? (
          <SelectField
            id="stop-target"
            label={scope === 'brand' ? t('stopAi.brand') : t('stopAi.agent')}
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            placeholder={t('stopAi.choose')}
            options={targets}
            error={errors.target}
          />
        ) : null}
        <TextareaField
          id="stop-reason"
          label={t('stopAi.reason')}
          hint={t('stopAi.reasonHint')}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          error={errors.reason}
        />
        {cancelled ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <ActionError error={isCancelled(stop.error) ? null : stop.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={stop.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" variant="destructive-solid" busy={stop.isPending}>
            {stop.isPending ? null : <OctagonPauseIcon aria-hidden="true" />}
            {t('stopAi.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
