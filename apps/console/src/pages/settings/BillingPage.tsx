import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useSearch } from '@tanstack/react-router';
import { CircleAlertIcon, CircleCheckIcon, ExternalLinkIcon, ReceiptIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '../../components/Fields';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { isApiError } from '../../lib/api';
import { formatAmount } from '../../lib/commerce';
import { formatBytes, formatDate, formatNumber } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import { type UsageMeter, useBilling } from '../../lib/reports';
import {
  type BillingSubscription,
  type PlanOption,
  type ProviderInvoice,
  useEmailSender,
  useOpenPortal,
  useProviderInvoices,
  useSetEmailSender,
  useStartCheckout,
  useSubscription,
} from '../../lib/saas';
import { useTenant } from '../../lib/tenant';
import { AiUsageCard } from './AiUsageCard';

const STATUS_TONE: Record<BillingSubscription['status'], StatusTone> = {
  none: 'neutral',
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  unpaid: 'danger',
  canceled: 'neutral',
  incomplete: 'warning',
  paused: 'neutral',
};

const INVOICE_TONE: Record<ProviderInvoice['status'], StatusTone> = {
  draft: 'neutral',
  open: 'info',
  paid: 'success',
  void: 'neutral',
  uncollectible: 'danger',
};

const METER_TONE: Record<UsageMeter['state'], StatusTone> = {
  unlimited: 'neutral',
  ok: 'success',
  warning: 'warning',
  reached: 'danger',
};

/** Sends the browser to a provider page (checkout, portal or client area). */
function go(url: string) {
  window.location.assign(url);
}

function amountOf(meter: UsageMeter, value: number): string {
  return meter.unit === 'byte' ? formatBytes(value) : formatNumber(value);
}

/** What came back from the provider's checkout (?checkout=done or cancelled). */
function CheckoutResult() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/_studio/settings/billing' });
  if (!search.checkout) return null;
  const done = search.checkout === 'done';
  return (
    <p
      role="status"
      data-testid="checkout-result"
      className={`flex items-start gap-2 rounded-lg border p-3 text-sm text-text ${
        done ? 'border-success/30 bg-success-subtle' : 'border-border bg-surface-muted'
      }`}
    >
      {done ? (
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      ) : null}
      {t(done ? 'billing.checkout.done' : 'billing.checkout.cancelled')}
    </p>
  );
}

function PlanSummary({ subscription }: { subscription: BillingSubscription }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const portal = useOpenPortal();
  const manage = async () => {
    try {
      go((await portal.mutateAsync(undefined)).url);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  const plan = subscription.plans.find((p) => p.current);
  return (
    <Section
      id="plan"
      title={t('billing.plan.title')}
      actions={
        subscription.canManage && can('billing.manage') ? (
          <Button
            variant="secondary"
            busy={portal.isPending}
            onClick={() => void manage()}
            data-testid="manage-billing"
          >
            <ExternalLinkIcon className="rtl:-scale-x-100" aria-hidden="true" />
            {t(
              subscription.provider === 'whmcs'
                ? 'billing.actions.clientArea'
                : 'billing.actions.manage',
            )}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xl font-semibold text-text" data-testid="current-plan">
          {subscription.plan ? <bdi>{subscription.plan.name}</bdi> : t('billing.plan.none')}
        </p>
        {subscription.status !== 'none' ? (
          <StatusBadge tone={STATUS_TONE[subscription.status]}>
            {t(`billing.status.${subscription.status}`)}
          </StatusBadge>
        ) : null}
      </div>
      {plan && plan.priceMinor !== '0' ? (
        <p className="text-sm text-text">
          {t('billing.plan.price', { price: formatAmount(plan.priceMinor, plan.currency) })}
        </p>
      ) : null}
      <p className="text-sm text-text-secondary">
        {t(`billing.plan.provider.${subscription.provider}`)}
      </p>
      {subscription.graceEndsAt ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm"
          data-testid="grace-notice"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-text">
            {t('billing.plan.grace', { date: formatDate(subscription.graceEndsAt) })}
          </p>
        </div>
      ) : null}
      {subscription.trialEndsAt ? (
        <p className="text-sm text-text" data-testid="trial-notice">
          {t('billing.plan.trial', { date: formatDate(subscription.trialEndsAt) })}
        </p>
      ) : null}
      {subscription.currentPeriodEnd && !subscription.graceEndsAt ? (
        <p className="text-sm text-text-secondary">
          {t(subscription.cancelAtPeriodEnd ? 'billing.plan.ends' : 'billing.plan.renews', {
            date: formatDate(subscription.currentPeriodEnd),
          })}
        </p>
      ) : null}
      <ActionError error={portal.error && !isCancelled(portal.error) ? portal.error : null} />
    </Section>
  );
}

/** The limits a plan card names: the ones people compare plans by. */
const SHOWN_LIMITS = ['conversations', 'aiReplies', 'seats'] as const;

function PlanLimits({ plan }: { plan: PlanOption }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1 text-sm text-text-secondary">
      {SHOWN_LIMITS.map((key) => {
        const value = plan.limits[key];
        return (
          <li key={key}>
            {t('billing.plans.limit', {
              limit: t(`reports.billing.limits.${key}`),
              value:
                value === null || value === undefined
                  ? t('billing.plans.unlimited')
                  : formatNumber(value),
            })}
          </li>
        );
      })}
    </ul>
  );
}

function Plans({ subscription }: { subscription: BillingSubscription }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const checkout = useStartCheckout();
  const [choosing, setChoosing] = useState<string | null>(null);
  const offered = subscription.plans.filter((plan) => plan.purchasable && !plan.current);
  if (!subscription.canUpgrade || offered.length === 0) return null;
  const choose = async (key: string) => {
    setChoosing(key);
    try {
      go((await checkout.mutateAsync(key)).url);
    } catch (caught) {
      if (isCancelled(caught)) return;
    } finally {
      setChoosing(null);
    }
  };
  return (
    <Section
      id="plans"
      title={t('billing.plans.title')}
      description={t('billing.plans.description')}
    >
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {offered.map((plan) => (
          <li
            key={plan.key}
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
            data-plan={plan.key}
          >
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-text">
                <bdi>{plan.name}</bdi>
              </p>
              <p className="text-sm text-text">
                {t('billing.plan.price', { price: formatAmount(plan.priceMinor, plan.currency) })}
              </p>
              {plan.trialDays > 0 ? (
                <p className="text-sm text-text-secondary">
                  {t('billing.plans.trialDays', { n: plan.trialDays })}
                </p>
              ) : null}
            </div>
            <PlanLimits plan={plan} />
            {can('billing.manage') ? (
              <Button
                className="mt-auto self-start"
                busy={choosing === plan.key}
                disabled={choosing !== null && choosing !== plan.key}
                onClick={() => void choose(plan.key)}
                aria-label={t('billing.actions.chooseLabel', { plan: plan.name })}
              >
                {t('billing.actions.upgrade')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!can('billing.manage') ? (
        <p className="text-sm text-text-secondary">{t('billing.plans.readOnly')}</p>
      ) : null}
      <ActionError error={checkout.error && !isCancelled(checkout.error) ? checkout.error : null} />
    </Section>
  );
}

function Usage() {
  const { t } = useTranslation();
  const billing = useBilling();
  return (
    <Section
      id="usage"
      title={t('billing.usage.title')}
      actions={
        <Button asChild variant="link" size="sm">
          <Link to="/reports">{t('billing.usage.details')}</Link>
        </Button>
      }
    >
      <QueryState query={billing} label={t('reports.billing.loading')}>
        {(data) => (
          <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="usage">
            {data.usage.meters.map((meter) => (
              <li
                key={meter.limit}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2"
                data-testid={`usage-${meter.limit}`}
              >
                <span className="text-sm font-medium text-text">
                  {t(`reports.billing.limits.${meter.limit}`)}
                </span>
                <span className="flex items-center gap-2 text-sm text-text">
                  {meter.max === null
                    ? t('reports.billing.usedUnlimited', { used: amountOf(meter, meter.used) })
                    : t('reports.billing.usedOf', {
                        used: amountOf(meter, meter.used),
                        max: amountOf(meter, meter.max),
                      })}
                  {meter.state === 'warning' || meter.state === 'reached' ? (
                    <StatusBadge tone={METER_TONE[meter.state]}>
                      {t(`reports.billing.states.${meter.state}`)}
                    </StatusBadge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

function ProviderInvoices() {
  const { t } = useTranslation();
  const invoices = useProviderInvoices(true);
  return (
    <QueryState
      query={invoices}
      label={t('billing.invoices.loading')}
      isEmpty={(data) => data.items.length === 0}
      empty={<NoInvoices />}
    >
      {(data) => (
        <div className="overflow-x-auto">
          <Table data-testid="provider-invoices">
            <TableHeader>
              <TableRow>
                <TableHead>{t('billing.invoices.number')}</TableHead>
                <TableHead>{t('billing.invoices.date')}</TableHead>
                <TableHead>{t('billing.invoices.total')}</TableHead>
                <TableHead>{t('billing.invoices.status')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('billing.invoices.links')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <bdi dir="ltr" className="font-mono text-xs">
                      {invoice.number ?? invoice.id}
                    </bdi>
                  </TableCell>
                  <TableCell>{formatDate(invoice.createdAt)}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatAmount(invoice.totalMinor, invoice.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={INVOICE_TONE[invoice.status]}>
                      {t(`billing.invoices.statuses.${invoice.status}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-3 text-sm">
                      {invoice.url ? (
                        <a
                          href={invoice.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-link underline underline-offset-2"
                        >
                          {t(
                            invoice.status === 'open'
                              ? 'billing.invoices.pay'
                              : 'billing.invoices.view',
                          )}
                        </a>
                      ) : null}
                      {invoice.pdfUrl ? (
                        <a
                          href={invoice.pdfUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-link underline underline-offset-2"
                        >
                          {t('billing.invoices.pdf')}
                        </a>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </QueryState>
  );
}

function NoInvoices() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
      <ReceiptIcon className="size-6 text-text-muted" aria-hidden="true" />
      <p className="text-sm text-text-secondary">{t('billing.invoices.empty')}</p>
    </div>
  );
}

/** Invoices this server issued itself (plans billed by hand); details are in Reports. */
function ServerInvoices() {
  const { t } = useTranslation();
  const billing = useBilling();
  return (
    <QueryState
      query={billing}
      label={t('billing.invoices.loading')}
      isEmpty={(data) => data.invoices.length === 0}
      empty={<NoInvoices />}
    >
      {(data) => (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {data.invoices.slice(0, 6).map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <bdi dir="ltr" className="font-mono text-xs">
                  {invoice.number}
                </bdi>
                <span className="text-text-secondary">{invoice.period.key}</span>
                <span className="tabular-nums text-text">
                  {formatAmount(invoice.totalMinor, invoice.currency)}
                </span>
                <StatusBadge
                  className="ms-auto"
                  tone={invoice.overdue ? 'danger' : invoice.status === 'paid' ? 'success' : 'info'}
                >
                  {invoice.overdue
                    ? t('reports.billing.invoices.overdue')
                    : t(`reports.billing.invoices.statuses.${invoice.status}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
          <Button asChild variant="link" size="sm" className="self-start">
            <Link to="/reports">{t('billing.invoices.allInReports')}</Link>
          </Button>
        </div>
      )}
    </QueryState>
  );
}

function SenderName() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const sender = useEmailSender();
  const save = useSetEmailSender();
  const [name, setName] = useState('');
  useEffect(() => {
    setName(sender.data?.senderName ?? '');
  }, [sender.data]);
  if (!can('settings.manage')) return null;
  const fieldError = isApiError(save.error)
    ? save.error.fields.find((f) => f.path === 'senderName')?.message
    : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await save.mutateAsync(name.trim() === '' ? null : name.trim());
      announce(t('billing.sender.saved'));
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <Section
      id="sender"
      title={t('billing.sender.title')}
      description={t('billing.sender.description')}
    >
      <QueryState query={sender} label={t('billing.sender.loading')}>
        {(data) => (
          <form
            className="flex max-w-md flex-col gap-4"
            onSubmit={(event) => void submit(event)}
            noValidate
          >
            <TextField
              id="sender-name"
              label={t('billing.sender.label')}
              hint={t('billing.sender.hint', { name: data.defaultName })}
              labelNote={t('app.optional')}
              value={name}
              maxLength={80}
              error={fieldError}
              onChange={(event) => setName(event.target.value)}
            />
            <ActionError
              error={save.error && !fieldError && !isCancelled(save.error) ? save.error : null}
            />
            <div>
              <Button type="submit" busy={save.isPending} data-testid="save-sender">
                {t('billing.sender.save')}
              </Button>
            </div>
          </form>
        )}
      </QueryState>
    </Section>
  );
}

/** Settings → Plan and billing: the plan, upgrades, usage, invoices and the email sender name. */
export function BillingPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const subscription = useSubscription();
  return (
    <div className="flex flex-col gap-6" data-testid="billing-page">
      <PageHeader title={t('billing.title')} description={t('billing.description')} />
      <CheckoutResult />
      {can('billing.read') ? (
        <QueryState query={subscription} label={t('billing.loading')}>
          {(data) => (
            <div className="flex flex-col gap-6">
              <PlanSummary subscription={data} />
              <Plans subscription={data} />
              <Usage />
              <AiUsageCard />
              <Section id="invoices" title={t('billing.invoices.title')}>
                {data.provider === 'stripe' ? (
                  <ProviderInvoices />
                ) : data.provider === 'whmcs' ? (
                  <p className="text-sm text-text-secondary">
                    {t('billing.invoices.inClientArea')}
                  </p>
                ) : (
                  <ServerInvoices />
                )}
              </Section>
            </div>
          )}
        </QueryState>
      ) : null}
      <SenderName />
    </div>
  );
}
