import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { DownloadIcon, EraserIcon, InfoIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DOCS } from '../../lib/docs';
import { formatDateTime, formatNumber } from '../../lib/format';
import {
  type PrivacyCustomer,
  type PrivacyCustomerSummary,
  type PrivacyReason,
  useCustomerDataAccess,
  useEraseCustomer,
  useExportCustomer,
  usePrivacyCustomer,
  usePrivacyCustomers,
} from '../../lib/privacy';
import { isCancelled } from '../../lib/reauth';
import { AppDialog, DialogFooter } from '../AppDialog';
import { SelectField, TextField } from '../Fields';
import { GuideLink } from '../GuideLink';
import { Section } from '../PageHeader';
import { ActionError, QueryState } from '../States';

const REASONS: readonly PrivacyReason[] = ['access_request', 'erasure_request', 'other'];

function useCustomerName() {
  const { t } = useTranslation();
  return (customer: PrivacyCustomer) =>
    customer.name ?? customer.email ?? customer.channel?.handle ?? t('privacy.customers.unnamed');
}

/** One customer's data on request (A10): find them, then download their data or erase them. */
export function CustomerData() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const found = usePrivacyCustomers(query);
  const short = draft.trim().length < 2;
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (short) return;
    setQuery(draft.trim());
    setChosen(null);
  };
  return (
    <Section
      id="customer-data"
      title={t('privacy.customers.title')}
      description={t('privacy.customers.description')}
      actions={<GuideLink href={DOCS.setup.privacy}>{t('privacy.customers.guide')}</GuideLink>}
    >
      <search>
        <form className="flex flex-wrap items-end gap-2" onSubmit={search} noValidate>
          <div className="min-w-0 flex-1 basis-64">
            <TextField
              id="privacy-search"
              type="search"
              autoComplete="off"
              label={t('privacy.customers.search')}
              hint={t('privacy.customers.searchHint')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={short} data-testid="privacy-find">
            <SearchIcon aria-hidden="true" />
            {t('privacy.customers.find')}
          </Button>
        </form>
      </search>
      {query ? (
        <QueryState query={found} label={t('privacy.customers.searching')}>
          {(data) =>
            data.items.length === 0 ? (
              <p className="text-sm text-text-secondary" role="status">
                {t('privacy.customers.none', { query })}
              </p>
            ) : (
              <Results items={data.items} chosen={chosen} onChoose={setChosen} />
            )
          }
        </QueryState>
      ) : null}
      {chosen ? <CustomerCard id={chosen} onClose={() => setChosen(null)} /> : null}
    </Section>
  );
}

function Results({
  items,
  chosen,
  onChoose,
}: {
  items: PrivacyCustomer[];
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useCustomerName();
  return (
    <ul aria-label={t('privacy.customers.results')} className="flex flex-col gap-2">
      {items.map((customer) => {
        const detail = [customer.email, customer.externalId, customer.channel?.handle].filter(
          (value, index, all): value is string => !!value && all.indexOf(value) === index,
        );
        return (
          <li key={customer.id}>
            <button
              type="button"
              data-testid="privacy-customer"
              aria-pressed={chosen === customer.id}
              onClick={() => onChoose(customer.id)}
              className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3 text-start hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:border-primary"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-text" dir="auto">
                  {nameOf(customer)}
                </span>
                <span className="truncate text-sm text-text-secondary" dir="auto">
                  {[...detail, customer.brand.name].join(' · ')}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-sm text-text-secondary">
                {customer.erasedAt ? (
                  <StatusBadge tone="neutral">{t('privacy.customers.erased')}</StatusBadge>
                ) : customer.lastSeenAt ? (
                  t('privacy.customers.lastSeen', { date: formatDateTime(customer.lastSeenAt) })
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CustomerCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const summary = usePrivacyCustomer(id);
  return (
    <QueryState query={summary} label={t('privacy.customers.loading')}>
      {(data) => <CustomerDetail summary={data} onClose={onClose} />}
    </QueryState>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-text-secondary">{term}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  );
}

function Note({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p data-testid={testId} className="flex items-start gap-2 text-sm text-text">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      {children}
    </p>
  );
}

function CustomerDetail({
  summary,
  onClose,
}: {
  summary: PrivacyCustomerSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const access = useCustomerDataAccess();
  const nameOf = useCustomerName();
  const [dialog, setDialog] = useState<'export' | 'erase' | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const { customer } = summary;
  const name = nameOf(customer);
  const done = (message: string) => {
    setStarted(message);
    announce(message);
  };
  return (
    <div
      data-testid="privacy-customer-card"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-muted p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-text" dir="auto">
            {name}
          </h3>
          <p className="text-sm text-text-secondary">{customer.brand.name}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('privacy.customers.close')}
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
        <Fact term={t('privacy.customers.id')}>
          <code className="break-all font-mono text-xs">{customer.id}</code>
        </Fact>
        <Fact term={t('privacy.customers.conversations')}>
          {formatNumber(summary.conversations)}
        </Fact>
        <Fact term={t('privacy.customers.orders')}>{formatNumber(summary.orders)}</Fact>
        <Fact term={t('privacy.customers.memories')}>{formatNumber(summary.memories)}</Fact>
      </dl>
      {customer.erasedAt ? (
        <Note testId="privacy-erased-note">{t('privacy.customers.erasedNote')}</Note>
      ) : (
        <>
          {summary.sharedContact ? (
            <Note testId="privacy-shared">{t('privacy.customers.shared')}</Note>
          ) : null}
          {summary.orders > 0 ? (
            <Note testId="privacy-orders-kept">{t('privacy.customers.ordersKept')}</Note>
          ) : null}
          {started ? (
            <p role="status" className="text-sm text-text" data-testid="privacy-started">
              {started}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {access.export ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="privacy-export"
                onClick={() => setDialog('export')}
              >
                <DownloadIcon aria-hidden="true" />
                {t('privacy.customers.download')}
              </Button>
            ) : null}
            {access.erase ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="privacy-erase"
                onClick={() => setDialog('erase')}
              >
                <EraserIcon aria-hidden="true" />
                {t('privacy.customers.erase')}
              </Button>
            ) : null}
          </div>
        </>
      )}
      <RequestDialog
        kind="export"
        open={dialog === 'export'}
        onOpenChange={(open) => setDialog(open ? 'export' : null)}
        customer={customer}
        name={name}
        onDone={() => done(t('privacy.customers.exportStarted'))}
      />
      <RequestDialog
        kind="erase"
        open={dialog === 'erase'}
        onOpenChange={(open) => setDialog(open ? 'erase' : null)}
        customer={customer}
        name={name}
        onDone={() => done(t('privacy.customers.eraseStarted'))}
      />
    </div>
  );
}

/**
 * Asks why, and for an erasure the customer's ID typed again, then queues the request. The button
 * shows progress and cannot be sent twice; a failure stays in the dialog.
 */
function RequestDialog({
  kind,
  open,
  onOpenChange,
  customer,
  name,
  onDone,
}: {
  kind: 'export' | 'erase';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: PrivacyCustomer;
  name: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const exporting = useExportCustomer(customer.id);
  const erasing = useEraseCustomer(customer.id);
  const testId = `privacy-${kind}-dialog`;
  const initial: PrivacyReason = kind === 'export' ? 'access_request' : 'erasure_request';
  const [reason, setReason] = useState<PrivacyReason>(initial);
  const [reference, setReference] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (!open) return;
    setReason(initial);
    setReference('');
    setConfirm('');
    setMismatch(false);
    setError(null);
    setCancelled(false);
  }, [open, initial]);
  const change = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'erase' && confirm.trim().toLowerCase() !== customer.id.toLowerCase()) {
      setMismatch(true);
      document.getElementById(`${testId}-confirm`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setCancelled(false);
    const body = { reason, ...(reference.trim() ? { reference: reference.trim() } : {}) };
    try {
      if (kind === 'export') await exporting.mutateAsync(body);
      else await erasing.mutateAsync({ ...body, confirm: confirm.trim() });
      setBusy(false);
      onOpenChange(false);
      onDone();
    } catch (caught) {
      setBusy(false);
      if (isCancelled(caught)) setCancelled(true);
      else setError(caught);
    }
  };
  return (
    <AppDialog
      open={open}
      onOpenChange={change}
      testId={testId}
      title={
        kind === 'export'
          ? t('privacy.customers.exportTitle', { name })
          : t('privacy.customers.eraseTitle', { name })
      }
    >
      <form className="flex flex-col gap-3 text-sm text-text" onSubmit={submit} noValidate>
        {kind === 'export' ? (
          <p>{t('privacy.customers.exportBody')}</p>
        ) : (
          <>
            <p>{t('privacy.customers.eraseBody')}</p>
            <p className="text-text-secondary">{t('privacy.customers.eraseKept')}</p>
          </>
        )}
        <SelectField
          id={`${testId}-reason`}
          label={t('privacy.customers.reason.label')}
          value={reason}
          onChange={(event) => setReason(event.target.value as PrivacyReason)}
          options={REASONS.map((value) => ({
            value,
            label: t(`privacy.customers.reason.${value}`),
          }))}
        />
        <TextField
          id={`${testId}-reference`}
          label={t('privacy.customers.reference')}
          hint={t('privacy.customers.referenceHint')}
          value={reference}
          maxLength={80}
          dir="auto"
          onChange={(event) => setReference(event.target.value)}
        />
        {kind === 'erase' ? (
          <TextField
            id={`${testId}-confirm`}
            label={t('privacy.customers.confirm', { id: customer.id })}
            value={confirm}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            onChange={(event) => {
              setConfirm(event.target.value);
              setMismatch(false);
            }}
            error={mismatch ? t('privacy.customers.confirmMismatch') : undefined}
          />
        ) : null}
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
          <Button
            type="submit"
            variant={kind === 'erase' ? 'destructive-solid' : 'default'}
            busy={busy}
            data-testid={`${testId}-submit`}
          >
            {kind === 'export'
              ? t('privacy.customers.exportSubmit')
              : t('privacy.customers.eraseSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
