import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { keys, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import type { MemoryChange, MemoryDeletionReceipt, MemoryItem } from '../../lib/types';
import { AppDialog, DialogFooter } from '../AppDialog';
import { TextareaField, TextField } from '../Fields';
import { SlotIcon, slotLabel, sourceLabel } from '../MemoryBadges';
import { ActionError } from '../States';

const REASON_MAX = 300;
const VALUE_MAX = 200;

/** The changes staff can make to one memory; each reloads the customer's memory when done. */
function useMemoryChange(customerId: string, memoryId: string) {
  const reload = [keys.memoryCustomer(customerId), keys.memoryCustomers];
  const path = `/v1/admin/memory/records/${memoryId}`;
  const correct = useStudioMutation(
    (body: { value: string; reason: string }, tenant) =>
      api<MemoryChange>(`${path}/correct`, { method: 'POST', tenant, body }),
    reload,
  );
  const remove = useStudioMutation(
    (body: { reason: string }, tenant) =>
      api<MemoryDeletionReceipt>(`${path}/delete`, { method: 'POST', tenant, body }),
    reload,
  );
  return { correct, remove };
}

/** The memory a dialog is about: what it is, what it says and where it came from. */
function Summary({ item }: { item: MemoryItem }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-muted p-3">
      <SlotIcon slot={item.key} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-text">{slotLabel(t, item.key)}</span>
        <bdi dir="auto" className="text-text">
          {item.value}
        </bdi>
        <span className="text-xs text-text-secondary">
          {sourceLabel(t, item)} · {formatDateTime(item.source.observedAt)}
        </span>
      </div>
    </div>
  );
}

function ReasonField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <TextareaField
      id={id}
      label={t('memory.reason.label')}
      hint={t('memory.reason.hint')}
      value={value}
      maxLength={REASON_MAX}
      rows={3}
      dir="auto"
      onChange={(event) => onChange(event.target.value)}
      error={error}
    />
  );
}

/** Corrects what is remembered: the new value replaces the old, which stays in the history. */
export function CorrectMemoryDialog({
  item,
  customerId,
  open,
  onOpenChange,
}: {
  item: MemoryItem;
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { correct } = useMemoryChange(customerId, item.id);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ value?: string; reason?: string }>({});
  const [cancelled, setCancelled] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setValue(item.value);
    setReason('');
    setErrors({});
    setCancelled(false);
    setFailure(null);
  }, [open, item.value]);

  const label = slotLabel(t, item.key);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: { value?: string; reason?: string } = {};
    if (!value.trim()) next.value = t('memory.panel.valueRequired');
    else if (value.trim() === item.value) next.value = t('memory.panel.valueSame');
    if (!reason.trim()) next.reason = t('memory.reason.required');
    setErrors(next);
    if (next.value || next.reason) {
      document.getElementById(next.value ? 'memory-card-value' : 'memory-card-reason')?.focus();
      return;
    }
    setCancelled(false);
    setFailure(null);
    try {
      const result = await correct.mutateAsync({ value: value.trim(), reason: reason.trim() });
      announce(t(result.outcome === 'unchanged' ? 'memory.panel.unchanged' : 'memory.panel.saved'));
      onOpenChange(false);
    } catch (caught) {
      if (isCancelled(caught)) setCancelled(true);
      else setFailure(caught);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!correct.isPending) onOpenChange(next);
      }}
      title={t('aiPower.memoryCard.correctTitle', { label })}
      description={t('aiPower.memoryCard.correctBody')}
      testId="memory-card-correct"
    >
      <form className="flex flex-col gap-4 text-sm text-text" onSubmit={submit} noValidate>
        <TextField
          id="memory-card-value"
          label={t('memory.panel.newValue')}
          dir="auto"
          maxLength={VALUE_MAX}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={errors.value}
        />
        <ReasonField
          id="memory-card-reason"
          value={reason}
          onChange={setReason}
          error={errors.reason}
        />
        {cancelled ? (
          <p role="status" className="text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <ActionError error={failure} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={correct.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={correct.isPending}>
            {t('memory.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Takes a memory out of use for good: it is not used in replies, and a record of it is kept. */
export function DeleteMemoryDialog({
  item,
  customerId,
  open,
  onOpenChange,
}: {
  item: MemoryItem;
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { remove } = useMemoryChange(customerId, item.id);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setMissing(false);
    setCancelled(false);
    setFailure(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setMissing(true);
      document.getElementById('memory-card-delete-reason')?.focus();
      return;
    }
    setCancelled(false);
    setFailure(null);
    try {
      await remove.mutateAsync({ reason: reason.trim() });
      announce(t('memory.notice.removed'));
      onOpenChange(false);
    } catch (caught) {
      if (isCancelled(caught)) setCancelled(true);
      else setFailure(caught);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) onOpenChange(next);
      }}
      title={t('memory.delete.title')}
      testId="memory-card-delete"
    >
      <form className="flex flex-col gap-3 text-sm text-text" onSubmit={submit} noValidate>
        <p>{t('memory.delete.intro')}</p>
        <Summary item={item} />
        <p>{t(item.status === 'pending' ? 'memory.delete.bodyPending' : 'memory.delete.body')}</p>
        <ReasonField
          id="memory-card-delete-reason"
          value={reason}
          onChange={(next) => {
            setReason(next);
            if (next.trim()) setMissing(false);
          }}
          error={missing ? t('memory.reason.required') : undefined}
        />
        {cancelled ? (
          <p role="status" className="text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <ActionError error={failure} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={remove.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" variant="destructive-solid" busy={remove.isPending}>
            {t('memory.delete.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
