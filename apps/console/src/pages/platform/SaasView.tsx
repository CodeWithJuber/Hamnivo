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
import { KeyRoundIcon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { CopyButton } from '../../components/CopyButton';
import { TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { formatAmount } from '../../lib/commerce';
import { formatDateTime } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import {
  type CreatedOperatorApiKey,
  type OperatorApiKey,
  useCreateOperatorKey,
  useOperatorKeys,
  usePlatformPlans,
  usePlatformSignup,
  useRevokeOperatorKey,
  useSetPlatformSignup,
} from '../../lib/saas';
import type { PlatformOperator } from '../../lib/types';
import { canPlatform } from './PlatformPage';

function SignupSwitch({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const signup = usePlatformSignup(true);
  const change = useSetPlatformSignup();
  const manage = canPlatform(operator, 'platform.settings.manage');
  const set = async (open: boolean | null) => {
    try {
      await change.mutateAsync(open);
      announce(t('billing.platform.signup.saved'));
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <Section
      id="signup"
      title={t('billing.platform.signup.title')}
      description={t('billing.platform.signup.description')}
    >
      <QueryState query={signup} label={t('billing.platform.signup.loading')}>
        {(data) => (
          <div className="flex flex-col gap-4" data-testid="signup-switch">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge tone={data.open ? 'success' : 'warning'}>
                {t(data.open ? 'billing.platform.signup.open' : 'billing.platform.signup.closed')}
              </StatusBadge>
              {data.overridden && data.updatedAt ? (
                <span className="text-sm text-text-secondary">
                  {t('billing.platform.signup.overridden', {
                    time: formatDateTime(data.updatedAt),
                  })}
                </span>
              ) : null}
            </div>
            <ul className="flex flex-col gap-1 text-sm text-text">
              <li>
                {t('billing.platform.signup.envDefault', {
                  state: t(
                    data.envDefault
                      ? 'billing.platform.signup.openShort'
                      : 'billing.platform.signup.closedShort',
                  ),
                })}
              </li>
              <li>
                {t(
                  data.turnstile
                    ? 'billing.platform.signup.turnstileOn'
                    : 'billing.platform.signup.turnstileOff',
                )}
              </li>
              <li>
                {t('billing.platform.signup.defaultPlan', {
                  plan:
                    data.defaultPlan === 'unlimited'
                      ? t('billing.platform.signup.unlimited')
                      : data.defaultPlan,
                })}
              </li>
            </ul>
            {manage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={data.open ? 'secondary' : 'default'}
                  busy={change.isPending && change.variables === !data.open}
                  disabled={!operator.mfa || change.isPending}
                  onClick={() => void set(!data.open)}
                  data-testid="toggle-signup"
                >
                  {t(
                    data.open ? 'billing.platform.signup.close' : 'billing.platform.signup.openIt',
                  )}
                </Button>
                {data.overridden ? (
                  <Button
                    variant="ghost"
                    busy={change.isPending && change.variables === null}
                    disabled={!operator.mfa || change.isPending}
                    onClick={() => void set(null)}
                  >
                    {t('billing.platform.signup.follow')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-text-secondary">
                {t('billing.platform.signup.needsAdmin')}
              </p>
            )}
            <ActionError error={change.error && !isCancelled(change.error) ? change.error : null} />
          </div>
        )}
      </QueryState>
    </Section>
  );
}

function Plans() {
  const { t } = useTranslation();
  const plans = usePlatformPlans(true);
  return (
    <Section
      id="plans"
      title={t('billing.platform.plans.title')}
      description={t('billing.platform.plans.description')}
    >
      <QueryState query={plans} label={t('billing.platform.plans.loading')}>
        {(data) => (
          <div className="overflow-x-auto">
            <Table data-testid="platform-plans">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('billing.platform.plans.name')}</TableHead>
                  <TableHead>{t('billing.platform.plans.key')}</TableHead>
                  <TableHead>{t('billing.platform.plans.price')}</TableHead>
                  <TableHead>{t('billing.platform.plans.trial')}</TableHead>
                  <TableHead>{t('billing.platform.plans.stripe')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((plan) => (
                  <TableRow key={plan.key}>
                    <TableCell>
                      <bdi>{plan.name}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi dir="ltr" className="font-mono text-xs">
                        {plan.key}
                      </bdi>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatAmount(plan.priceMinor, plan.currency)}
                    </TableCell>
                    <TableCell>
                      {plan.trialDays > 0
                        ? t('billing.platform.plans.trialDays', { n: plan.trialDays })
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {plan.stripePriceId ? (
                        <bdi dir="ltr" className="font-mono text-xs">
                          {plan.stripePriceId}
                        </bdi>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
    </Section>
  );
}

function CreatedKey({ created }: { created: CreatedOperatorApiKey }) {
  const { t } = useTranslation();
  const value = useRef<HTMLElement>(null);
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-success/30 bg-success-subtle p-3 text-sm"
      data-testid="created-operator-key"
    >
      <p className="font-medium text-text">{t('billing.platform.keys.created')}</p>
      <code
        ref={value}
        dir="ltr"
        className="break-all rounded bg-surface px-2 py-1 font-mono text-xs"
      >
        {created.key}
      </code>
      <CopyButton
        text={created.key}
        label={t('billing.platform.keys.copy')}
        copiedLabel={t('billing.platform.keys.copied')}
        failedLabel={t('billing.platform.keys.copyFailed')}
        selectTarget={() => value.current}
      />
    </div>
  );
}

function OperatorKeys({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const keys = useOperatorKeys(true);
  const create = useCreateOperatorKey();
  const revoke = useRevokeOperatorKey();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<CreatedOperatorApiKey | null>(null);
  const [revoking, setRevoking] = useState<OperatorApiKey | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('billing.platform.keys.nameRequired'));
      return;
    }
    setError(undefined);
    try {
      const key = await create.mutateAsync(name.trim());
      setCreated(key);
      setName('');
      announce(t('billing.platform.keys.created'));
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <Section
      id="operator-keys"
      title={t('billing.platform.keys.title')}
      description={t('billing.platform.keys.description')}
    >
      <form
        className="flex max-w-md flex-col gap-3"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <TextField
          id="operator-key-name"
          label={t('billing.platform.keys.name')}
          hint={t('billing.platform.keys.nameHint')}
          value={name}
          maxLength={80}
          error={error}
          onChange={(event) => setName(event.target.value)}
        />
        <ActionError error={create.error && !isCancelled(create.error) ? create.error : null} />
        <div>
          <Button
            type="submit"
            busy={create.isPending}
            disabled={!operator.mfa}
            data-testid="create-operator-key"
          >
            <KeyRoundIcon aria-hidden="true" />
            {t('billing.platform.keys.create')}
          </Button>
        </div>
      </form>
      {created ? <CreatedKey created={created} /> : null}
      <QueryState
        query={keys}
        label={t('billing.platform.keys.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('billing.platform.keys.empty')}</p>}
      >
        {(data) => (
          <div className="overflow-x-auto">
            <Table data-testid="operator-keys">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('billing.platform.keys.name')}</TableHead>
                  <TableHead>{t('billing.platform.keys.prefix')}</TableHead>
                  <TableHead>{t('billing.platform.keys.createdAt')}</TableHead>
                  <TableHead>{t('billing.platform.keys.lastUsed')}</TableHead>
                  <TableHead>{t('billing.platform.keys.status')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('billing.platform.keys.revoke')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <bdi>{key.name}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi dir="ltr" className="font-mono text-xs">
                        {key.prefix}
                      </bdi>
                    </TableCell>
                    <TableCell>{formatDateTime(key.createdAt)}</TableCell>
                    <TableCell>
                      {key.lastUsedAt
                        ? formatDateTime(key.lastUsedAt)
                        : t('billing.platform.keys.never')}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={key.revokedAt ? 'neutral' : 'success'}>
                        {t(
                          key.revokedAt
                            ? 'billing.platform.keys.revoked'
                            : 'billing.platform.keys.active',
                        )}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? null : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!operator.mfa}
                          onClick={() => setRevoking(key)}
                          aria-label={t('billing.platform.keys.revokeLabel', { name: key.name })}
                        >
                          {t('billing.platform.keys.revoke')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('billing.platform.keys.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('billing.platform.keys.revoke')}
        variant="destructive-solid"
        testId="revoke-operator-key"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          announce(t('billing.platform.keys.revokedDone'));
        }}
      >
        <p>{t('billing.platform.keys.revokeBody')}</p>
      </ConfirmDialog>
    </Section>
  );
}

/** Running the server as a service: the sign-up switch, plans and operator API keys (A17). */
export function SaasView({ operator }: { operator: PlatformOperator }) {
  return (
    <div className="flex flex-col gap-6">
      <SignupSwitch operator={operator} />
      <Plans />
      {canPlatform(operator, 'platform.settings.manage') ? (
        <OperatorKeys operator={operator} />
      ) : null}
    </div>
  );
}
