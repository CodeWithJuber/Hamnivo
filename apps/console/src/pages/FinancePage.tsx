import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { ToggleGroup, ToggleGroupItem } from '@hamnivo/ui/components/toggle-group';
import { Link } from '@tanstack/react-router';
import { CheckCircle2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../components/AppDialog';
import { SelectField, TextareaField } from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import {
  type FinanceExceptionView,
  formatWhen,
  useExceptionAction,
  useFinanceExceptions,
} from '../lib/commerce';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';

const RESOLUTIONS = [
  'provider_confirmed',
  'manual_review',
  'refunded_elsewhere',
  'written_off',
] as const;

function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-text-secondary">
            <bdi dir="ltr" className="font-mono">
              {key}
            </bdi>
          </dt>
          <dd>
            <bdi dir="ltr" className="font-mono">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExceptionItem({ item }: { item: FinanceExceptionView }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const action = useExceptionAction();
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>('manual_review');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-exception={item.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={item.state === 'open' ? 'warning' : 'success'}>
          {t(`commerce.finance.kind.${item.kind}`)}
        </StatusBadge>
        {item.order ? (
          <Link
            to="/orders/$orderId"
            params={{ orderId: item.order.id }}
            className="text-sm text-link underline underline-offset-2"
          >
            {t('commerce.finance.order', { reference: item.order.reference })}
          </Link>
        ) : null}
      </div>
      <p className="text-sm text-text">
        {t('commerce.finance.nextAction', {
          action: t(`commerce.finance.action.${item.nextSafeAction}`),
        })}
      </p>
      <p className="text-sm text-text-secondary">
        {t('commerce.finance.providerState', { state: item.sourceState })} ·{' '}
        {t('commerce.finance.openedAt', { time: formatWhen(item.openedAt) })}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-text-secondary">
          {t('commerce.finance.evidence')}
        </summary>
        <Evidence evidence={item.evidence} />
      </details>
      {item.resolution ? (
        <p className="text-sm text-text-secondary">
          {t('commerce.finance.resolvedAs', {
            resolution: t(`commerce.finance.resolutions.${item.resolution}`),
          })}
          {item.resolutionNote ? (
            <>
              {' · '}
              <bdi>{item.resolutionNote}</bdi>
            </>
          ) : null}
        </p>
      ) : null}
      {item.state === 'open' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            busy={action.isPending}
            onClick={() =>
              void action
                .mutateAsync({ exceptionId: item.id, action: 'check' })
                .catch(() => undefined)
            }
          >
            {t('commerce.finance.check')}
          </Button>
          {can('commerce.exceptions.resolve') ? (
            <Button onClick={() => setResolving(true)}>{t('commerce.finance.resolve')}</Button>
          ) : null}
        </div>
      ) : null}
      <AppDialog
        open={resolving}
        onOpenChange={(next) => {
          if (!next) {
            setNote('');
            setError(null);
          }
          setResolving(next);
        }}
        title={t('commerce.finance.resolveTitle')}
        description={t(`commerce.finance.kind.${item.kind}`)}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!note.trim()) return;
            try {
              await action.mutateAsync({
                exceptionId: item.id,
                action: 'resolve',
                resolution,
                note: note.trim(),
              });
              setResolving(false);
            } catch (caught) {
              if (!isCancelled(caught)) setError(caught);
            }
          }}
        >
          <SelectField
            id={`resolution-${item.id}`}
            label={t('commerce.finance.resolution')}
            value={resolution}
            onChange={(event) => setResolution(event.target.value as (typeof RESOLUTIONS)[number])}
            options={RESOLUTIONS.map((value) => ({
              value,
              label: t(`commerce.finance.resolutions.${value}`),
            }))}
          />
          <TextareaField
            id={`resolution-note-${item.id}`}
            label={t('commerce.finance.note')}
            value={note}
            required
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setResolving(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" busy={action.isPending} disabled={!note.trim()}>
              {t('commerce.finance.resolveConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </AppDialog>
    </li>
  );
}

/** Money situations that need a person (C19), with their evidence and next safe step. */
export function FinancePage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const exceptions = useFinanceExceptions(state);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('commerce.finance.title')}
        description={t('commerce.finance.description')}
      />
      <Section
        id="exceptions"
        title={t('commerce.finance.title')}
        actions={
          <ToggleGroup
            type="single"
            value={state}
            onValueChange={(value) => {
              if (value === 'open' || value === 'resolved') setState(value);
            }}
            aria-label={t('commerce.finance.tabs')}
          >
            <ToggleGroupItem value="open">{t('commerce.finance.open')}</ToggleGroupItem>
            <ToggleGroupItem value="resolved">{t('commerce.finance.resolved')}</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        <QueryState
          query={exceptions}
          label={t('commerce.finance.loading')}
          permitted={can('commerce.read')}
          isEmpty={(data) => data.items.length === 0}
          empty={
            <EmptyState
              kind="no-records"
              icon={<CheckCircle2Icon className="size-6 text-text-muted" aria-hidden="true" />}
              title={
                state === 'open' ? t('commerce.finance.empty') : t('commerce.finance.emptyResolved')
              }
              action={
                <Button asChild variant="secondary">
                  <Link to="/orders">{t('commerce.nav.orders')}</Link>
                </Button>
              }
            />
          }
        >
          {(data) => (
            <ul className="flex flex-col gap-3" data-testid="exceptions">
              {data.items.map((item) => (
                <ExceptionItem key={item.id} item={item} />
              ))}
            </ul>
          )}
        </QueryState>
      </Section>
    </div>
  );
}
