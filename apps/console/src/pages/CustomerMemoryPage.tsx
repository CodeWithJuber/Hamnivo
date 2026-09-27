import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CircleCheckIcon,
  DownloadIcon,
  EraserIcon,
  HistoryIcon,
  InfoIcon,
  LockIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../components/AppDialog';
import { CheckboxField, TextareaField, TextField } from '../components/Fields';
import {
  ConsentBadge,
  customerName,
  DeletionStatusBadge,
  isPreference,
  MemoryStatusBadge,
  SlotIcon,
  slotLabel,
  slotPurpose,
  sourceLabel,
} from '../components/MemoryBadges';
import { PageHeader } from '../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../components/States';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { useNames } from '../lib/names';
import { keys, useCustomerMemory, useStudioMutation } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import type {
  MemoryChange,
  MemoryCustomerDetail,
  MemoryDeletionReceipt,
  MemoryExport,
  MemoryItem,
} from '../lib/types';
import type { MemoryTab } from '../routes/_studio/memory/$customerId';

/** Tab labels in the Studio text colours, so inactive ones keep enough contrast. */
const TAB = 'text-text-secondary hover:text-text data-[state=active]:text-text';

const REASON_MAX = 300;
const VALUE_MAX = 200;

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/** Who wrote a memory, in words. */
function useWriterName() {
  const { t } = useTranslation();
  const names = useNames();
  return (item: Pick<MemoryItem, 'writtenBy'>) => {
    switch (item.writtenBy.type) {
      case 'ai':
        return names.agent(item.writtenBy.id) ?? item.writtenBy.name ?? t('memory.writers.ai');
      case 'staff':
        return item.writtenBy.name ?? t('memory.writers.staff');
      case 'customer':
        return t('memory.writers.customer');
      default:
        return t('memory.writers.system');
    }
  };
}

/** The changes staff can make to one memory; each reloads the customer's memory when done. */
function useMemoryActions(customerId: string, memoryId: string) {
  const invalidate = [keys.memoryCustomer(customerId), keys.memoryCustomers];
  const path = `/v1/admin/memory/records/${memoryId}`;
  const correct = useStudioMutation(
    (body: { value: string; reason: string }, tenant) =>
      api<MemoryChange>(`${path}/correct`, { method: 'POST', tenant, body }),
    invalidate,
  );
  const change = useStudioMutation(
    (input: { action: 'outdated' | 'confirm'; reason: string }, tenant) =>
      api<MemoryChange>(`${path}/${input.action}`, {
        method: 'POST',
        tenant,
        body: { reason: input.reason },
      }),
    invalidate,
  );
  const remove = useStudioMutation(
    (input: { action: 'delete' | 'reject'; reason: string }, tenant) =>
      api<MemoryDeletionReceipt>(`${path}/${input.action}`, {
        method: 'POST',
        tenant,
        body: { reason: input.reason },
      }),
    invalidate,
  );
  return { correct, change, remove };
}

/** A required reason, with the reminder to keep personal details out of it. */
function ReasonField({
  id,
  value,
  onChange,
  error,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <TextareaField
      id={id}
      label={label ?? t('memory.reason.label')}
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

/**
 * Asks for the reason, then makes the change. The button shows progress and cannot be sent twice;
 * a failure stays in the dialog, and nothing closes until the change succeeds.
 */
function ReasonDialog({
  open,
  onOpenChange,
  title,
  children,
  extra,
  confirmLabel,
  variant = 'default',
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
  /** Fields after the reason. */
  extra?: ReactNode;
  confirmLabel: string;
  variant?: 'default' | 'destructive-solid';
  onConfirm: (reason: string) => Promise<unknown>;
  testId: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (!open) return;
    setReason('');
    setMissing(false);
    setError(null);
    setCancelled(false);
  }, [open]);
  const change = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setMissing(true);
      document.getElementById(`${testId}-reason`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      await onConfirm(reason.trim());
      setBusy(false);
      onOpenChange(false);
    } catch (caught) {
      setBusy(false);
      if (isCancelled(caught)) setCancelled(true);
      else setError(caught);
    }
  };
  return (
    <AppDialog open={open} onOpenChange={change} title={title} testId={testId}>
      <form className="flex flex-col gap-3 text-sm text-text" onSubmit={submit} noValidate>
        {children}
        <ReasonField
          id={`${testId}-reason`}
          value={reason}
          onChange={(value) => {
            setReason(value);
            if (value.trim()) setMissing(false);
          }}
          error={missing ? t('memory.reason.required') : undefined}
        />
        {extra}
        {cancelled ? (
          <p role="status" className="text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <ActionError error={error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => change(false)} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" variant={variant} busy={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function ItemSummary({ item }: { item: MemoryItem }) {
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

function CustomerCard({
  detail,
  onErase,
  onExport,
  exporting,
}: {
  detail: MemoryCustomerDetail;
  onErase: () => void;
  onExport: () => void;
  exporting: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const names = useNames();
  const consent = detail.consent;
  return (
    <section
      aria-labelledby="customer-name"
      className="flex flex-wrap items-start gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <span
        aria-hidden="true"
        className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-lg font-semibold text-text"
      >
        {initials(detail.customer.displayName ?? '')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="customer-name" className="text-xl font-semibold text-text">
          <bdi>{customerName(t, detail.customer)}</bdi>
        </h2>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-text-secondary">
          {detail.customer.email ? (
            <>
              <bdi dir="ltr">{detail.customer.email}</bdi>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>{t('memory.customer.since', { date: formatDateTime(detail.customer.since) })}</span>
          <span aria-hidden="true">·</span>
          <bdi>{names.brand(detail.customer.brandId) ?? detail.customer.brandId}</bdi>
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ConsentBadge state={consent.state} />
          <StatusBadge tone={detail.customer.verified ? 'info' : 'neutral'}>
            {t(
              detail.customer.verified ? 'memory.customer.verified' : 'memory.customer.notVerified',
            )}
          </StatusBadge>
          <span className="text-sm text-text-secondary" data-testid="consent-line">
            {consent.decidedAt && consent.state !== 'undecided'
              ? t(`memory.consent.line.${consent.state}`, {
                  date: formatDateTime(consent.decidedAt),
                })
              : t('memory.consent.line.undecided')}
          </span>
        </div>
        {detail.consentHistory.length > 1 ? (
          <details className="pt-1 text-sm">
            <summary className="cursor-pointer text-text-secondary">
              {t('memory.consent.history')}
            </summary>
            <ol className="mt-2 flex flex-col gap-1">
              {detail.consentHistory.map((record) => (
                <li key={`${record.decidedAt}-${record.state}`} className="text-text-secondary">
                  {t(`memory.consent.${record.state}`)} ·{' '}
                  {t(`memory.consent.by.${record.decidedBy}`)} · {formatDateTime(record.decidedAt)}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {can('memory.export') ? (
          <Button variant="secondary" size="sm" busy={exporting} onClick={onExport}>
            {exporting ? null : <DownloadIcon aria-hidden="true" />}
            {t('memory.actions.export')}
          </Button>
        ) : null}
        {can('memory.erase') ? (
          <Button variant="destructive" size="sm" onClick={onErase}>
            <EraserIcon aria-hidden="true" />
            {t('memory.actions.erase')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** A value under review next to the current one (HNV-15-03). */
function ConflictCard({
  customerId,
  pending,
  current,
  onCompare,
  onConfirmed,
}: {
  customerId: string;
  pending: MemoryItem;
  current: MemoryItem | undefined;
  onCompare: () => void;
  onConfirmed: (change: MemoryChange) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [confirming, setConfirming] = useState(false);
  const actions = useMemoryActions(customerId, pending.id);
  const label = slotLabel(t, pending.key);
  return (
    <section
      aria-labelledby={`conflict-${pending.id}`}
      data-testid="memory-conflict"
      className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning-subtle p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`conflict-${pending.id}`} className="font-semibold text-text">
            {t('memory.conflict.title', { label })}
          </h2>
          <p className="text-sm text-text">
            {t(current ? 'memory.conflict.body' : 'memory.conflict.bodyNoCurrent', {
              date: formatDateTime(pending.source.observedAt),
            })}
          </p>
          <p className="text-sm text-text-secondary">{t('memory.conflict.customerCan')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 ps-8">
        <Button size="sm" variant="secondary" onClick={onCompare}>
          {t('memory.conflict.compare')}
        </Button>
        {can('memory.manage') ? (
          <Button size="sm" onClick={() => setConfirming(true)}>
            {t('memory.conflict.confirm')}
          </Button>
        ) : null}
      </div>
      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('memory.confirmReview.title', { label })}
        confirmLabel={t('memory.conflict.confirm')}
        testId={`memory-confirm-${pending.id}`}
        onConfirm={async (reason) =>
          onConfirmed(await actions.change.mutateAsync({ action: 'confirm', reason }))
        }
      >
        <ItemSummary item={pending} />
        <p>{t('memory.confirmReview.body')}</p>
      </ReasonDialog>
    </section>
  );
}

function MemoryTable({
  id,
  items,
  selected,
  onSelect,
  empty,
  searchLabel,
}: {
  id: string;
  items: MemoryItem[];
  selected: string | undefined;
  onSelect: (item: MemoryItem) => void;
  empty: string;
  searchLabel: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    if (!words) return items;
    return items.filter((item) =>
      `${slotLabel(t, item.key)} ${item.value}`.toLowerCase().includes(words),
    );
  }, [items, query, t]);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <label className="sr-only" htmlFor={`${id}-filter`}>
          {searchLabel}
        </label>
        <input
          id={`${id}-filter`}
          type="search"
          dir="auto"
          value={query}
          placeholder={searchLabel}
          onChange={(event) => setQuery(event.target.value)}
          className="h-10 w-full rounded-md border border-input bg-surface ps-9 pe-3 text-sm text-text"
        />
      </div>
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
          {items.length === 0 ? empty : t('memory.table.noMatch')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid={`memory-items-${id}`}>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('memory.table.columns.memory')}</TableHead>
                <TableHead className="text-start">{t('memory.table.columns.purpose')}</TableHead>
                <TableHead className="text-start">{t('memory.table.columns.source')}</TableHead>
                <TableHead className="text-start">{t('memory.table.columns.confirmed')}</TableHead>
                <TableHead className="text-start">{t('memory.table.columns.visibility')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((item) => (
                <TableRow
                  key={item.id}
                  data-memory={item.key}
                  data-status={item.status}
                  data-selected={item.id === selected ? 'true' : undefined}
                  className="data-[selected=true]:bg-surface-muted"
                >
                  <TableCell className="max-w-64 whitespace-normal">
                    <div className="flex items-start gap-3">
                      <SlotIcon
                        slot={item.key}
                        className="mt-0.5 size-5 shrink-0 text-text-muted"
                      />
                      <div className="flex min-w-0 flex-col items-start gap-0.5">
                        <Button
                          variant="link"
                          className="h-auto p-0 text-start font-medium whitespace-normal"
                          aria-current={item.id === selected ? 'true' : undefined}
                          onClick={() => onSelect(item)}
                        >
                          {slotLabel(t, item.key)}
                        </Button>
                        <bdi dir="auto" className="text-sm text-text">
                          {item.value}
                        </bdi>
                        {item.status === 'pending' ? <MemoryStatusBadge item={item} /> : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal text-sm text-text-secondary">
                    {slotPurpose(t, item)}
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm">
                    <span className="block">{sourceLabel(t, item)}</span>
                    <span className="block text-text-secondary">
                      {formatDateTime(item.source.observedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {formatDateTime(item.lastConfirmedAt ?? item.recordedAt)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone="neutral" icon={null}>
                      {t(`memory.scope.short.${item.scope}`)}
                    </StatusBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-secondary">{term}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </>
  );
}

/** One memory: where it came from and who wrote it (HNV-15-02), with corrections (HNV-15-04). */
function MemoryPanel({
  item,
  detail,
  onChanged,
  onDeleted,
  onClose,
}: {
  item: MemoryItem;
  detail: MemoryCustomerDetail;
  onChanged: (change: MemoryChange, message: string) => void;
  onDeleted: (receipt: MemoryDeletionReceipt) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const writer = useWriterName();
  const { correct, change, remove } = useMemoryActions(detail.customer.id, item.id);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ value?: string; reason?: string }>({});
  const [dialog, setDialog] = useState<'outdated' | 'delete' | 'confirm' | 'reject' | null>(null);

  const itemId = item.id;
  const initialValue = item.status === 'active' ? item.value : '';
  useEffect(() => {
    setValue(initialValue);
    setReason('');
    setErrors({});
    if (itemId) document.getElementById('memory-panel-title')?.focus();
  }, [itemId, initialValue]);

  const current =
    item.status === 'pending'
      ? detail.items.find((other) => other.id === item.conflictsWith)
      : undefined;
  const history = detail.history.filter((other) => other.key === item.key && other.id !== item.id);
  const manage = can('memory.manage');
  const label = slotLabel(t, item.key);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next: { value?: string; reason?: string } = {};
    if (!value.trim()) next.value = t('memory.panel.valueRequired');
    else if (value.trim() === item.value) next.value = t('memory.panel.valueSame');
    if (!reason.trim()) next.reason = t('memory.reason.required');
    setErrors(next);
    if (next.value || next.reason) {
      document.getElementById(next.value ? 'memory-new-value' : 'memory-reason')?.focus();
      return;
    }
    try {
      const result = await correct.mutateAsync({ value: value.trim(), reason: reason.trim() });
      onChanged(
        result,
        t(result.outcome === 'unchanged' ? 'memory.panel.unchanged' : 'memory.panel.saved'),
      );
    } catch {
      // Shown next to the form.
    }
  };

  return (
    <section
      aria-labelledby="memory-panel-title"
      data-testid="memory-panel"
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="flex items-start gap-3">
        <SlotIcon slot={item.key} className="mt-1 size-5 shrink-0 text-text-muted" />
        <h2
          id="memory-panel-title"
          tabIndex={-1}
          className="min-w-0 flex-1 text-lg font-semibold text-text"
        >
          {label}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label={t('app.close')} onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle p-3 text-sm text-text">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        {t('memory.panel.onlyApproved')}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <Fact term={t('memory.panel.value')}>
          <bdi dir="auto" className="font-medium" data-testid="memory-value">
            {item.value}
          </bdi>
        </Fact>
        <Fact term={t('memory.panel.status')}>
          <MemoryStatusBadge item={item} />
        </Fact>
        <Fact term={t('memory.panel.purpose')}>{slotPurpose(t, item)}</Fact>
        <Fact term={t('memory.panel.source')}>
          <span className="block">
            {sourceLabel(t, item)} · {formatDateTime(item.source.observedAt)}
          </span>
          {item.source.messageIds.length > 0 ? (
            <span className="block text-xs text-text-secondary">
              {t('memory.panel.messages')}{' '}
              <bdi dir="ltr" className="font-mono break-all">
                {item.source.messageIds.join(', ')}
              </bdi>
            </span>
          ) : null}
          {item.source.conversationId ? (
            <span className="block text-xs text-text-secondary">
              {t('memory.panel.conversation')}{' '}
              <bdi dir="ltr" className="font-mono break-all">
                {item.source.conversationId}
              </bdi>
            </span>
          ) : null}
        </Fact>
        <Fact term={t('memory.panel.recordedBy')}>
          <bdi>{writer(item)}</bdi>
          <span className="block text-xs text-text-secondary">
            {t(`memory.reasons.${item.reason}`)} · {formatDateTime(item.recordedAt)}
          </span>
        </Fact>
        {item.note ? (
          <Fact term={t('memory.panel.note')}>
            <bdi dir="auto">{item.note}</bdi>
          </Fact>
        ) : null}
        <Fact term={t('memory.panel.scope')}>{t(`memory.scope.long.${item.scope}`)}</Fact>
        <Fact term={t('memory.panel.inEffect')}>{formatDateTime(item.validFrom)}</Fact>
        <Fact term={t('memory.panel.expires')}>
          {item.expiresAt ? formatDateTime(item.expiresAt) : t('memory.panel.noExpiry')}
        </Fact>
        {item.evidenceStatus === 'unknown' ? (
          <Fact term={t('memory.panel.verified')}>{t('memory.panel.notVerified')}</Fact>
        ) : null}
        <Fact term={t('memory.panel.version')}>{formatNumber(item.version)}</Fact>
      </dl>

      {item.status === 'pending' ? (
        <div className="flex flex-col gap-3" data-testid="memory-compare">
          <h3 className="text-sm font-semibold text-text">{t('memory.conflict.compareTitle')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <span className="text-xs text-text-secondary">{t('memory.conflict.current')}</span>
              <bdi dir="auto" className="font-medium">
                {current?.value ?? t('memory.conflict.none')}
              </bdi>
              {current ? (
                <span className="text-xs text-text-secondary">
                  {formatDateTime(current.source.observedAt)}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-warning/40 p-3">
              <span className="text-xs text-text-secondary">{t('memory.conflict.newer')}</span>
              <bdi dir="auto" className="font-medium">
                {item.value}
              </bdi>
              <span className="text-xs text-text-secondary">
                {formatDateTime(item.source.observedAt)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {manage ? (
              <>
                <Button size="sm" onClick={() => setDialog('confirm')}>
                  {t('memory.conflict.confirm')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setDialog('reject')}>
                  {t('memory.conflict.keep')}
                </Button>
              </>
            ) : null}
            {can('memory.delete') ? (
              <Button size="sm" variant="destructive" onClick={() => setDialog('delete')}>
                <Trash2Icon aria-hidden="true" />
                {t('memory.actions.delete')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {item.status === 'active' && (manage || can('memory.delete')) ? (
        <form className="flex flex-col gap-3" onSubmit={save} noValidate>
          {manage ? (
            <>
              <h3 className="text-sm font-semibold text-text">{t('memory.panel.edit')}</h3>
              <TextField
                id="memory-new-value"
                label={t('memory.panel.newValue')}
                dir="auto"
                maxLength={VALUE_MAX}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                error={errors.value}
              />
              <ReasonField
                id="memory-reason"
                label={t('memory.panel.correctionReason')}
                value={reason}
                onChange={setReason}
                error={errors.reason}
              />
              <ActionError error={correct.error} />
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {manage ? (
              <Button type="button" variant="secondary" onClick={() => setDialog('outdated')}>
                {t('memory.actions.outdated')}
              </Button>
            ) : null}
            {can('memory.delete') ? (
              <Button type="button" variant="destructive" onClick={() => setDialog('delete')}>
                <Trash2Icon aria-hidden="true" />
                {t('memory.actions.delete')}
              </Button>
            ) : null}
            {manage ? (
              <Button type="submit" busy={correct.isPending} className="ms-auto">
                {t('memory.actions.save')}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {history.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
            <HistoryIcon className="size-4 text-text-muted" aria-hidden="true" />
            {t('memory.panel.history')}
          </h3>
          <ol className="flex flex-col gap-2" data-testid="memory-history">
            {history.map((old) => (
              <li
                key={old.id}
                className="flex flex-col gap-0.5 rounded-lg border border-border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <bdi dir="auto" className="font-medium">
                    {old.value}
                  </bdi>
                  <MemoryStatusBadge item={old} />
                </div>
                <span className="text-xs text-text-secondary">
                  {t('memory.panel.historyLine', {
                    writer: writer(old),
                    from: formatDateTime(old.validFrom),
                    until: formatDateTime(old.validUntil ?? old.supersededAt),
                  })}
                </span>
                {old.note ? (
                  <bdi dir="auto" className="text-xs text-text-secondary">
                    {old.note}
                  </bdi>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <ReasonDialog
        open={dialog === 'outdated'}
        onOpenChange={(open) => setDialog(open ? 'outdated' : null)}
        title={t('memory.outdated.title')}
        confirmLabel={t('memory.outdated.submit')}
        testId="memory-outdated-dialog"
        onConfirm={async (why) =>
          onChanged(
            await change.mutateAsync({ action: 'outdated', reason: why }),
            t('memory.outdated.done'),
          )
        }
      >
        <ItemSummary item={item} />
        <p>{t('memory.outdated.body')}</p>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => setDialog(open ? 'delete' : null)}
        title={t('memory.delete.title')}
        confirmLabel={t('memory.delete.submit')}
        variant="destructive-solid"
        testId="memory-delete-dialog"
        onConfirm={async (why) =>
          onDeleted(await remove.mutateAsync({ action: 'delete', reason: why }))
        }
      >
        <p>{t('memory.delete.intro')}</p>
        <ItemSummary item={item} />
        <p>{t(item.status === 'pending' ? 'memory.delete.bodyPending' : 'memory.delete.body')}</p>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'confirm'}
        onOpenChange={(open) => setDialog(open ? 'confirm' : null)}
        title={t('memory.confirmReview.title', { label })}
        confirmLabel={t('memory.conflict.confirm')}
        testId="memory-confirm-dialog"
        onConfirm={async (why) =>
          onChanged(
            await change.mutateAsync({ action: 'confirm', reason: why }),
            t('memory.confirmReview.done'),
          )
        }
      >
        <ItemSummary item={item} />
        <p>{t('memory.confirmReview.body')}</p>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'reject'}
        onOpenChange={(open) => setDialog(open ? 'reject' : null)}
        title={t('memory.reject.title')}
        confirmLabel={t('memory.conflict.keep')}
        testId="memory-reject-dialog"
        onConfirm={async (why) =>
          onDeleted(await remove.mutateAsync({ action: 'reject', reason: why }))
        }
      >
        <ItemSummary item={item} />
        <p>{t('memory.reject.body')}</p>
      </ReasonDialog>
    </section>
  );
}

/** What a deletion did, and whether indexes and caches are done yet (HNV-15-05). */
function DeletionNotice({
  receipt,
  onDismiss,
}: {
  receipt: MemoryDeletionReceipt;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="deletion-notice"
      data-deletion-status={receipt.status}
      className="flex items-start gap-3 rounded-xl border border-success/30 bg-success-subtle p-4"
    >
      <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold text-text">
          {t(receipt.scope === 'customer' ? 'memory.notice.erased' : 'memory.notice.removed')}
        </p>
        <p className="text-sm text-text">
          {t(receipt.status === 'completed' ? 'memory.notice.completed' : 'memory.notice.pending')}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t('app.close')} onClick={onDismiss}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Deletions and what each one did: the audit trail of forgetting (HNV-15-05). */
function DeletionHistory({ deletions }: { deletions: MemoryDeletionReceipt[] }) {
  const { t } = useTranslation();
  if (deletions.length === 0) return null;
  return (
    <section
      aria-labelledby="memory-deletions-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <h2 id="memory-deletions-title" className="text-lg font-semibold text-text">
        {t('memory.deletions.title')}
      </h2>
      <p className="text-sm text-text-secondary">{t('memory.deletions.description')}</p>
      <ol className="flex flex-col gap-3" data-testid="memory-deletions">
        {deletions.map((receipt) => (
          <li
            key={receipt.id}
            data-deletion-status={receipt.status}
            className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">
                {t(`memory.deletions.scope.${receipt.scope}`, {
                  total: formatNumber(receipt.records),
                })}
              </span>
              <DeletionStatusBadge receipt={receipt} />
            </div>
            <span className="text-text-secondary">
              {t('memory.deletions.line', {
                who:
                  receipt.requestedBy.name ??
                  t(`memory.deletions.requester.${receipt.requestedBy.type}`),
                reason: t(`memory.deletions.reasons.${receipt.reason}`),
                time: formatDateTime(receipt.createdAt),
              })}
            </span>
            <ul className="flex flex-wrap gap-2" aria-label={t('memory.deletions.steps')}>
              {receipt.steps.map((step) => (
                <li key={step.step}>
                  <StatusBadge tone={step.status === 'done' ? 'success' : 'info'}>
                    {t(`memory.deletions.stepNames.${step.step}`)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
            <span className="text-xs text-text-secondary">
              {t('memory.deletions.kept', {
                items: receipt.kept
                  .map((kept) => t(`memory.deletions.keptNames.${kept}`))
                  .join(', '),
              })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EraseDialog({
  open,
  onOpenChange,
  detail,
  onErased,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: MemoryCustomerDetail;
  onErased: (receipt: MemoryDeletionReceipt) => void;
}) {
  const { t } = useTranslation();
  const [turnOff, setTurnOff] = useState(true);
  const customerId = detail.customer.id;
  const erase = useStudioMutation(
    (body: { reason: string; turnOff: boolean }, tenant) =>
      api<MemoryDeletionReceipt>(`/v1/admin/memory/customers/${customerId}/erase`, {
        method: 'POST',
        tenant,
        body,
      }),
    [keys.memoryCustomer(customerId), keys.memoryCustomers],
  );
  useEffect(() => {
    if (open) setTurnOff(true);
  }, [open]);
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('memory.erase.title', { name: customerName(t, detail.customer) })}
      confirmLabel={t('memory.erase.submit')}
      variant="destructive-solid"
      testId="memory-erase-dialog"
      onConfirm={async (reason) => onErased(await erase.mutateAsync({ reason, turnOff }))}
      extra={
        <CheckboxField
          id="memory-erase-turn-off"
          label={t('memory.erase.turnOff')}
          hint={t('memory.erase.turnOffHint')}
          checked={turnOff}
          onCheckedChange={setTurnOff}
        />
      }
    >
      <p>
        {t('memory.erase.body', {
          total: formatNumber(detail.items.length + detail.history.length),
        })}
      </p>
      <p className="text-text-secondary">{t('memory.erase.kept')}</p>
    </ReasonDialog>
  );
}

function download(data: MemoryExport, customerId: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `customer-memory-${customerId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function CustomerMemory({ detail }: { detail: MemoryCustomerDetail }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/memory/$customerId' });
  const customerId = detail.customer.id;
  const [erasing, setErasing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const exporter = useStudioMutation((_: undefined, tenant) =>
    api<MemoryExport>(`/v1/admin/memory/customers/${customerId}/export`, { tenant }),
  );
  const tab: MemoryTab = search.tab ?? 'preferences';
  const selected = [...detail.items, ...detail.history].find((item) => item.id === search.memory);
  const receipt = notice ? detail.deletions.find((d) => d.id === notice) : undefined;
  const pending = detail.items.filter((item) => item.status === 'pending');
  const preferences = detail.items.filter(isPreference);
  const facts = detail.items.filter((item) => !isPreference(item));

  const go = (next: { tab?: MemoryTab; memory?: string | undefined }) => {
    const nextTab = next.tab ?? tab;
    return navigate({
      to: '/memory/$customerId',
      params: { customerId },
      search: {
        ...(nextTab !== 'preferences' ? { tab: nextTab } : {}),
        ...(next.memory ? { memory: next.memory } : {}),
      },
      replace: true,
    });
  };

  const select = (item: MemoryItem) => {
    setStatus(null);
    void go({ tab: isPreference(item) ? 'preferences' : 'facts', memory: item.id });
  };

  const deleted = (done: MemoryDeletionReceipt) => {
    setStatus(null);
    setNotice(done.id);
    announce(t(done.scope === 'customer' ? 'memory.notice.erased' : 'memory.notice.removed'));
    void go({ memory: undefined });
  };

  const changed = (result: MemoryChange, message: string) => {
    announce(message);
    setStatus(message);
    void go({ memory: result.memory.status === 'outdated' ? undefined : result.memory.id });
  };

  return (
    <div className="flex flex-col gap-6">
      <CustomerCard
        detail={detail}
        onErase={() => setErasing(true)}
        exporting={exporter.isPending}
        onExport={async () => {
          try {
            download(await exporter.mutateAsync(undefined), customerId);
            announce(t('memory.exported'));
          } catch {
            // Shown below the card.
          }
        }}
      />
      <ActionError error={exporter.error} />
      {!detail.offered ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3 text-sm text-text"
          data-testid="memory-not-offered"
        >
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
          {t('memory.notOffered')}
        </p>
      ) : null}
      {receipt ? <DeletionNotice receipt={receipt} onDismiss={() => setNotice(null)} /> : null}
      {pending.map((item) => (
        <ConflictCard
          key={item.id}
          customerId={customerId}
          pending={item}
          current={detail.items.find((other) => other.id === item.conflictsWith)}
          onCompare={() => select(item)}
          onConfirmed={(result) => changed(result, t('memory.confirmReview.done'))}
        />
      ))}

      {status ? (
        <p
          data-testid="memory-status"
          className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-subtle p-3 text-sm text-text"
        >
          <CircleCheckIcon className="size-4 shrink-0 text-success" aria-hidden="true" />
          {status}
        </p>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section
          aria-labelledby="memory-items-title"
          className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
        >
          <h2 id="memory-items-title" tabIndex={-1} className="text-lg font-semibold text-text">
            {t('memory.table.title')}
          </h2>
          <Tabs value={tab} onValueChange={(value) => void go({ tab: value as MemoryTab })}>
            <TabsList variant="line" className="h-auto flex-wrap justify-start">
              <TabsTrigger value="preferences" className={TAB}>
                {t('memory.tabs.preferences')} ({formatNumber(preferences.length)})
              </TabsTrigger>
              <TabsTrigger value="facts" className={TAB}>
                {t('memory.tabs.facts')} ({formatNumber(facts.length)})
              </TabsTrigger>
              <TabsTrigger value="notes" className={TAB}>
                {t('memory.tabs.notes')}
                <LockIcon aria-hidden="true" />
                <span className="text-xs text-text-secondary">{t('memory.tabs.internal')}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="preferences" className="pt-2">
              <MemoryTable
                id="preferences"
                items={preferences}
                selected={selected?.id}
                onSelect={select}
                empty={t('memory.table.emptyPreferences')}
                searchLabel={t('memory.table.searchPreferences')}
              />
            </TabsContent>
            <TabsContent value="facts" className="pt-2">
              <MemoryTable
                id="facts"
                items={facts}
                selected={selected?.id}
                onSelect={select}
                empty={t('memory.table.emptyFacts')}
                searchLabel={t('memory.table.searchFacts')}
              />
            </TabsContent>
            <TabsContent value="notes" className="pt-2">
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
                {t('memory.table.notes')}
              </p>
            </TabsContent>
          </Tabs>
        </section>
        {selected ? (
          <MemoryPanel
            item={selected}
            detail={detail}
            onClose={() =>
              void go({ memory: undefined }).then(() =>
                document.getElementById('memory-items-title')?.focus(),
              )
            }
            onChanged={changed}
            onDeleted={deleted}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
            {t('memory.panel.pick')}
          </p>
        )}
      </div>

      <DeletionHistory deletions={detail.deletions} />
      <EraseDialog open={erasing} onOpenChange={setErasing} detail={detail} onErased={deleted} />
    </div>
  );
}

/** One customer's memory (board 15: HNV-15-02 to 15-06). */
export function CustomerMemoryPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { customerId } = useParams({ from: '/_studio/memory/$customerId' });
  const memory = useCustomerMemory(customerId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('memory.title')}
        description={t('memory.description')}
        eyebrow={
          <Link
            to="/memory"
            className="inline-flex items-center gap-1 text-sm text-link underline-offset-4 hover:underline"
          >
            <ArrowLeftIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            {t('memory.allCustomers')}
          </Link>
        }
      />
      <QueryState
        query={memory}
        label={t('memory.loading')}
        permitted={can('memory.read')}
        forbidden={
          <Forbidden
            title={t('memory.forbidden.title')}
            description={t('memory.forbidden.description')}
          />
        }
      >
        {(detail) => <CustomerMemory detail={detail} />}
      </QueryState>
    </div>
  );
}
