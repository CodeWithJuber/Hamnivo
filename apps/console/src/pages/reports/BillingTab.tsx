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
import { CircleAlertIcon, ReceiptIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog } from '../../components/AppDialog';
import { CheckboxField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { isApiError } from '../../lib/api';
import { formatAmount } from '../../lib/commerce';
import { formatBytes, formatDate, formatNumber } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import {
  type BillingOverview,
  type InvoiceSummary,
  type UsageMeter,
  useBilling,
  useInvoice,
  useSetBudget,
} from '../../lib/reports';
import { useTenant } from '../../lib/tenant';

const THRESHOLDS = [50, 80, 90, 100] as const;

const METER_TONE: Record<UsageMeter['state'], StatusTone> = {
  unlimited: 'neutral',
  ok: 'success',
  warning: 'warning',
  reached: 'danger',
};

/** The bar's fill: the plain accent until the limit is near. */
const METER_FILL: Record<UsageMeter['state'], string> = {
  unlimited: 'bg-primary',
  ok: 'bg-primary',
  warning: 'bg-warning',
  reached: 'bg-danger',
};

const INVOICE_TONE: Record<InvoiceSummary['status'], StatusTone> = {
  draft: 'neutral',
  issued: 'info',
  paid: 'success',
  void: 'neutral',
};

function amountOf(meter: UsageMeter, value: number): string {
  return meter.unit === 'byte' ? formatBytes(value) : formatNumber(value);
}

function Meter({ meter }: { meter: UsageMeter }) {
  const { t } = useTranslation();
  const share = meter.max === null || meter.max === 0 ? 0 : Math.min(1, meter.used / meter.max);
  return (
    <li className="flex flex-col gap-2" data-testid={`meter-${meter.limit}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-text">{t(`reports.billing.limits.${meter.limit}`)}</p>
        <StatusBadge tone={METER_TONE[meter.state]}>
          {t(`reports.billing.states.${meter.state}`)}
        </StatusBadge>
      </div>
      <p className="text-sm text-text">
        {meter.max === null
          ? t('reports.billing.usedUnlimited', { used: amountOf(meter, meter.used) })
          : t('reports.billing.usedOf', {
              used: amountOf(meter, meter.used),
              max: amountOf(meter, meter.max),
            })}
      </p>
      {meter.max !== null ? (
        // A measure within a known range, filled from the inline start (from the right in Arabic
        // and Urdu).
        // biome-ignore lint/a11y/useSemanticElements: <meter> cannot take the design tokens in every browser
        <div
          role="meter"
          aria-label={t('reports.billing.meterLabel', {
            limit: t(`reports.billing.limits.${meter.limit}`),
          })}
          aria-valuemin={0}
          aria-valuemax={meter.max}
          aria-valuenow={Math.min(meter.used, meter.max)}
          aria-valuetext={t('reports.billing.usedOf', {
            used: amountOf(meter, meter.used),
            max: amountOf(meter, meter.max),
          })}
          className="h-2 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <div
            className={`h-full rounded-full ${METER_FILL[meter.state]}`}
            style={{ width: `${share * 100}%` }}
          />
        </div>
      ) : null}
      <p className="text-xs text-text-secondary">
        {meter.kind === 'period' ? t('reports.billing.perPeriod') : t('reports.billing.inUse')}
      </p>
    </li>
  );
}

function BudgetForm({ billing }: { billing: BillingOverview }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const budget = billing.usage.budget;
  const [tokens, setTokens] = useState(budget.aiTokens === null ? '' : String(budget.aiTokens));
  const [thresholds, setThresholds] = useState<number[]>(budget.alertThresholds);
  useEffect(() => {
    setTokens(budget.aiTokens === null ? '' : String(budget.aiTokens));
    setThresholds(budget.alertThresholds);
  }, [budget]);
  const save = useSetBudget();
  const fields = new Map(
    isApiError(save.error) ? save.error.fields.map((f) => [f.path, f.message]) : [],
  );
  const manage = can('billing.manage');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await save.mutateAsync({
        aiTokens: tokens.trim() === '' ? null : Number(tokens),
        alertThresholds: thresholds,
      });
      announce(t('reports.billing.budget.saved'));
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <fieldset disabled={!manage} className="flex flex-col gap-4">
        <legend className="sr-only">{t('reports.billing.budget.title')}</legend>
        <TextField
          id="budget-tokens"
          label={t('reports.billing.budget.tokens')}
          hint={t('reports.billing.budget.tokensHint')}
          labelNote={t('app.optional')}
          inputMode="numeric"
          value={tokens}
          error={fields.get('aiTokens')}
          onChange={(event) => setTokens(event.target.value.replace(/[^\d]/g, ''))}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-text">
            {t('reports.billing.budget.alerts')}
          </legend>
          <div className="flex flex-wrap gap-4">
            {THRESHOLDS.map((value) => (
              <CheckboxField
                key={value}
                id={`threshold-${value}`}
                label={t('reports.billing.budget.threshold', { value })}
                checked={thresholds.includes(value)}
                onCheckedChange={(checked) =>
                  setThresholds((current) =>
                    checked
                      ? [...current, value].sort((a, b) => a - b)
                      : current.filter((v) => v !== value),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      </fieldset>
      <ActionError error={save.error && fields.size === 0 ? save.error : null} />
      {manage ? (
        <div>
          <Button type="submit" busy={save.isPending} data-testid="save-budget">
            {t('reports.billing.budget.save')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">{t('reports.billing.budget.readOnly')}</p>
      )}
    </form>
  );
}

function InvoiceDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const invoice = useInvoice(id);
  return (
    <AppDialog
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('reports.billing.invoice.title', { number: invoice.data?.number ?? '' })}
      className="sm:max-w-2xl"
      testId="invoice-dialog"
    >
      <QueryState query={invoice} label={t('reports.billing.invoice.loading')}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              {t('reports.billing.invoice.period', {
                plan: data.planName,
                from: formatDate(data.period.start),
                to: formatDate(new Date(Date.parse(data.period.end) - 1)),
              })}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('reports.billing.invoice.item')}</TableHead>
                    <TableHead>{t('reports.billing.invoice.quantity')}</TableHead>
                    <TableHead>{t('reports.billing.invoice.amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: invoice lines have no id and never reorder
                    <TableRow key={index}>
                      <TableCell className="whitespace-normal">
                        {line.kind === 'plan'
                          ? t('reports.billing.invoice.planLine', { plan: data.planName })
                          : t('reports.billing.invoice.meteredLine', {
                              limit: t(
                                `reports.billing.limits.${line.limit as UsageMeter['limit']}`,
                              ),
                              included: formatNumber(line.includedUnits),
                            })}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {line.kind === 'plan' ? '1' : formatNumber(line.billableUnits)}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatAmount(line.amountMinor, data.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-end text-md font-semibold text-text">
              {t('reports.billing.invoice.total', {
                amount: formatAmount(data.totalMinor, data.currency),
              })}
            </p>
            <p className="text-xs text-text-secondary">{t('reports.billing.invoice.taxNote')}</p>
          </div>
        )}
      </QueryState>
    </AppDialog>
  );
}

/** The plan, usage against its limits, the AI budget and invoices (A08, A15, A16). */
export function BillingTab() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const billing = useBilling();
  const [invoice, setInvoice] = useState<string | null>(null);
  return (
    <QueryState
      query={billing}
      label={t('reports.billing.loading')}
      permitted={can('billing.read')}
    >
      {(data) => (
        <div className="flex flex-col gap-6" data-testid="billing">
          {data.standing === 'past_due' ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-danger">{t('reports.billing.pastDue.title')}</p>
                <p className="text-text">{t('reports.billing.pastDue.description')}</p>
              </div>
            </div>
          ) : null}
          {!data.usage.ai.allowed ? (
            <p
              className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text"
              data-testid="ai-paused"
            >
              {t(`reports.billing.aiPaused.${data.usage.ai.reason ?? 'plan_replies'}`)}
            </p>
          ) : null}
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <Section
              id="usage"
              title={t('reports.billing.usage.title')}
              description={t('reports.billing.usage.period', {
                from: formatDate(data.usage.period.start),
                to: formatDate(new Date(Date.parse(data.usage.period.end) - 1)),
              })}
            >
              {data.plan ? (
                <p className="text-sm text-text" data-testid="plan-name">
                  {t('reports.billing.plan', {
                    plan: data.plan.name,
                    price: formatAmount(data.plan.priceMinor, data.plan.currency),
                  })}
                </p>
              ) : (
                <p className="text-sm text-text-secondary" data-testid="plan-name">
                  {t('reports.billing.noPlan')}
                </p>
              )}
              <ul className="grid gap-5 sm:grid-cols-2">
                {data.usage.meters.map((meter) => (
                  <Meter key={meter.limit} meter={meter} />
                ))}
              </ul>
              {data.usage.alerts.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-text">{t('reports.billing.alerts')}</p>
                  <ul className="flex flex-col gap-1 text-sm text-text-secondary">
                    {data.usage.alerts.map((alert) => (
                      <li key={`${alert.limit}-${alert.source}-${alert.threshold}`}>
                        {t('reports.billing.alert', {
                          limit: t(`reports.billing.limits.${alert.limit as UsageMeter['limit']}`),
                          threshold: alert.threshold,
                          date: formatDate(alert.at),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Section>
            <Section
              id="budget"
              title={t('reports.billing.budget.title')}
              description={t('reports.billing.budget.description')}
            >
              <BudgetForm billing={data} />
            </Section>
          </div>
          <Section id="invoices" title={t('reports.billing.invoices.title')}>
            {data.invoices.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
                <ReceiptIcon className="size-6 text-text-muted" aria-hidden="true" />
                <p className="text-sm text-text-secondary">{t('reports.billing.invoices.empty')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="invoices">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reports.billing.invoices.number')}</TableHead>
                      <TableHead>{t('reports.billing.invoices.period')}</TableHead>
                      <TableHead>{t('reports.billing.invoices.total')}</TableHead>
                      <TableHead>{t('reports.billing.invoices.status')}</TableHead>
                      <TableHead>{t('reports.billing.invoices.due')}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t('reports.billing.invoices.view')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invoices.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <bdi dir="ltr" className="font-mono text-xs">
                            {row.number}
                          </bdi>
                        </TableCell>
                        <TableCell>{row.period.key}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatAmount(row.totalMinor, row.currency)}
                        </TableCell>
                        <TableCell>
                          <span className="flex flex-wrap gap-1">
                            <StatusBadge tone={INVOICE_TONE[row.status]}>
                              {t(`reports.billing.invoices.statuses.${row.status}`)}
                            </StatusBadge>
                            {row.overdue ? (
                              <StatusBadge tone="danger">
                                {t('reports.billing.invoices.overdue')}
                              </StatusBadge>
                            ) : null}
                            {row.payment.state === 'failed' ? (
                              <StatusBadge tone="warning">
                                {t('reports.billing.invoices.paymentFailed')}
                              </StatusBadge>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell>
                          {row.paidAt
                            ? t('reports.billing.invoices.paidOn', { date: formatDate(row.paidAt) })
                            : row.dueAt
                              ? formatDate(row.dueAt)
                              : '—'}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setInvoice(row.id)}
                            aria-label={t('reports.billing.invoices.viewLabel', {
                              number: row.number,
                            })}
                          >
                            {t('reports.billing.invoices.view')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
          <InvoiceDialog id={invoice} onClose={() => setInvoice(null)} />
        </div>
      )}
    </QueryState>
  );
}
