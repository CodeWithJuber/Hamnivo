import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextareaField } from '../../components/Fields';
import { ActionError, QueryState } from '../../components/States';
import { formatBytes, formatDate, formatNumber } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import type { UsageMeter } from '../../lib/reports';
import {
  type PlatformTenantBilling,
  useAssignPlan,
  usePlatformPlans,
  useSetTenantState,
  useTenantBilling,
} from '../../lib/saas';
import type { PlatformOperator } from '../../lib/types';
import { canPlatform } from './PlatformPage';

const amountOf = (meter: UsageMeter, value: number) =>
  meter.unit === 'byte' ? formatBytes(value) : formatNumber(value);

function PlanDialog({
  tenantId,
  name,
  billing,
  onOpenChange,
  onDone,
}: {
  tenantId: string;
  name: string;
  billing: PlatformTenantBilling;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const plans = usePlatformPlans(true);
  const assign = useAssignPlan(tenantId);
  const [planKey, setPlanKey] = useState(billing.plan?.key ?? '');
  const [trial, setTrial] = useState(false);
  const chosen = plans.data?.items.find((plan) => plan.key === planKey);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!planKey) return;
    try {
      await assign.mutateAsync({ planKey, startTrial: trial && (chosen?.trialDays ?? 0) > 0 });
      onDone(t('billing.platform.tenant.assigned'));
      onOpenChange(false);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!assign.isPending) onOpenChange(open);
      }}
      title={t('billing.platform.tenant.assignTitle', { name })}
      testId="assign-plan-dialog"
    >
      <QueryState query={plans} label={t('billing.platform.plans.loading')}>
        {(data) => (
          <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)} noValidate>
            <SelectField
              id="assign-plan"
              label={t('billing.platform.tenant.planField')}
              value={planKey}
              placeholder={t('billing.platform.tenant.pickPlan')}
              onChange={(event) => {
                setPlanKey(event.target.value);
                setTrial(false);
              }}
              options={data.items.map((plan) => ({ value: plan.key, label: plan.name }))}
            />
            {chosen && chosen.trialDays > 0 ? (
              <CheckboxField
                id="assign-trial"
                label={t('billing.platform.tenant.startTrial', { n: chosen.trialDays })}
                checked={trial}
                onCheckedChange={setTrial}
              />
            ) : null}
            {billing.provider === 'stripe' && billing.subscriptionStatus !== 'none' ? (
              <p className="text-sm text-text-secondary">
                {t('billing.platform.tenant.stripeNote')}
              </p>
            ) : null}
            <ActionError error={assign.error && !isCancelled(assign.error) ? assign.error : null} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                type="submit"
                busy={assign.isPending}
                disabled={!planKey}
                data-testid="assign-plan-submit"
              >
                {t('billing.platform.tenant.assign')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </QueryState>
    </AppDialog>
  );
}

function StateDialog({
  tenantId,
  name,
  action,
  onOpenChange,
  onDone,
}: {
  tenantId: string;
  name: string;
  action: 'suspend' | 'reactivate';
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const change = useSetTenantState(tenantId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError(t('billing.platform.tenant.reasonShort'));
      return;
    }
    setError(undefined);
    try {
      await change.mutateAsync({ action, reason: reason.trim() });
      onDone(
        t(
          action === 'suspend'
            ? 'billing.platform.tenant.suspendedDone'
            : 'billing.platform.tenant.reactivatedDone',
        ),
      );
      onOpenChange(false);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!change.isPending) onOpenChange(open);
      }}
      title={t(
        action === 'suspend'
          ? 'billing.platform.tenant.suspendTitle'
          : 'billing.platform.tenant.reactivateTitle',
        { name },
      )}
      description={t(
        action === 'suspend'
          ? 'billing.platform.tenant.suspendBody'
          : 'billing.platform.tenant.reactivateBody',
      )}
      testId="tenant-state-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)} noValidate>
        <TextareaField
          id="tenant-state-reason"
          label={t('billing.platform.tenant.reason')}
          hint={t('billing.platform.tenant.reasonHint')}
          value={reason}
          rows={3}
          maxLength={500}
          error={error}
          onChange={(event) => setReason(event.target.value)}
        />
        <ActionError error={change.error && !isCancelled(change.error) ? change.error : null} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            variant={action === 'suspend' ? 'destructive-solid' : 'default'}
            busy={change.isPending}
            data-testid="tenant-state-submit"
          >
            {t(
              action === 'suspend'
                ? 'billing.platform.tenant.suspend'
                : 'billing.platform.tenant.reactivate',
            )}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/**
 * A tenant's plan, trial, subscription and usage this period, with the platform admin's
 * controls: change the plan (or start its trial), suspend and reactivate (A17).
 */
export function TenantPlanPanel({
  tenantId,
  name,
  operator,
}: {
  tenantId: string;
  name: string;
  operator: PlatformOperator;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const billing = useTenantBilling(tenantId);
  const [dialog, setDialog] = useState<'plan' | 'suspend' | 'reactivate' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = canPlatform(operator, 'platform.tenants.manage');
  const done = (message: string) => {
    setNotice(message);
    announce(message);
  };
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      data-testid="tenant-plan"
    >
      <h3 className="font-semibold text-text">{t('billing.platform.tenant.title')}</h3>
      <QueryState query={billing} label={t('billing.platform.tenant.loading')}>
        {(data) => (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-text-secondary">{t('billing.platform.tenant.plan')}</dt>
              <dd data-testid="tenant-plan-name">
                {data.plan ? <bdi>{data.plan.name}</bdi> : t('billing.platform.tenant.noPlan')}
                {data.trialEndsAt ? (
                  <span className="text-text-secondary">
                    {' · '}
                    {t('billing.platform.tenant.trial', { date: formatDate(data.trialEndsAt) })}
                  </span>
                ) : null}
              </dd>
              <dt className="text-text-secondary">{t('billing.platform.tenant.provider')}</dt>
              <dd>
                {t(`billing.providers.${data.provider}`)}
                {data.subscriptionStatus !== 'none' ? (
                  <span className="text-text-secondary">
                    {' · '}
                    {t(`billing.status.${data.subscriptionStatus}`)}
                  </span>
                ) : null}
              </dd>
              {data.graceEndsAt ? (
                <>
                  <dt className="text-text-secondary">{t('billing.platform.tenant.graceLabel')}</dt>
                  <dd>
                    <StatusBadge tone="warning">
                      {t('billing.platform.tenant.grace', { date: formatDate(data.graceEndsAt) })}
                    </StatusBadge>
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-text">{t('billing.platform.tenant.usage')}</p>
              <ul
                className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
                data-testid="tenant-usage"
              >
                {data.meters.map((meter) => (
                  <li key={meter.limit} className="flex justify-between gap-2">
                    <span className="text-text-secondary">
                      {t(`reports.billing.limits.${meter.limit}`)}
                    </span>
                    <span className={meter.state === 'reached' ? 'text-danger' : 'text-text'}>
                      {meter.max === null
                        ? t('reports.billing.usedUnlimited', { used: amountOf(meter, meter.used) })
                        : t('reports.billing.usedOf', {
                            used: amountOf(meter, meter.used),
                            max: amountOf(meter, meter.max),
                          })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {manage && data.status !== 'closing' ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!operator.mfa}
                  onClick={() => setDialog('plan')}
                  data-testid="change-plan"
                >
                  {t('billing.platform.tenant.assign')}
                </Button>
                {data.status === 'active' ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!operator.mfa}
                    onClick={() => setDialog('suspend')}
                    data-testid="suspend-tenant"
                  >
                    {t('billing.platform.tenant.suspend')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!operator.mfa}
                    onClick={() => setDialog('reactivate')}
                    data-testid="reactivate-tenant"
                  >
                    {t('billing.platform.tenant.reactivate')}
                  </Button>
                )}
              </div>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-text">
                {notice}
              </p>
            ) : null}
            {dialog === 'plan' ? (
              <PlanDialog
                tenantId={tenantId}
                name={name}
                billing={data}
                onOpenChange={(open) => setDialog(open ? 'plan' : null)}
                onDone={done}
              />
            ) : null}
            {dialog === 'suspend' || dialog === 'reactivate' ? (
              <StateDialog
                tenantId={tenantId}
                name={name}
                action={dialog}
                onOpenChange={(open) => setDialog(open ? dialog : null)}
                onDone={done}
              />
            ) : null}
          </div>
        )}
      </QueryState>
    </div>
  );
}
