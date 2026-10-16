import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { AlertTriangleIcon, ClockIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader, Section } from '../../components/PageHeader';
import { CustomerData } from '../../components/privacy/CustomerData';
import { PrivacyRequests } from '../../components/privacy/PrivacyRequests';
import { ActionError, Forbidden, QueryState } from '../../components/States';
import { DOCS } from '../../lib/docs';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';
import {
  choiceOf,
  daysOf,
  deletesSooner,
  KEEP_FOREVER,
  type RetentionPolicy,
  useRetention,
  useRetentionPreview,
  useSetRetention,
} from '../../lib/privacy';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';

/**
 * Settings → Privacy (A10): how long the workspace keeps conversations (owners), and one
 * customer's data on request (whoever may export or erase customers).
 */
export function PrivacyPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const retention = can('privacy.manage');
  const customers = can('customers.export') || can('customers.erase');
  if (!retention && !customers) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('privacy.title')} />
        <Forbidden />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('privacy.title')} description={t('privacy.description')} />
      {retention ? <Retention /> : null}
      {customers ? <CustomerData /> : null}
      {customers ? <PrivacyRequests /> : null}
    </div>
  );
}

function Retention() {
  const { t } = useTranslation();
  const policy = useRetention();
  return (
    <Section
      id="retention"
      title={t('privacy.retention.title')}
      description={t('privacy.retention.description')}
      actions={<GuideLink href={DOCS.setup.privacy}>{t('privacy.retention.guide')}</GuideLink>}
    >
      <QueryState query={policy} label={t('privacy.retention.loading')}>
        {(data) => <RetentionForm policy={data} />}
      </QueryState>
    </Section>
  );
}

function RetentionForm({ policy }: { policy: RetentionPolicy }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const save = useSetRetention();
  // The choice shown is the one that will apply: a waiting change, or what is kept now.
  const target = policy.pending?.conversationDays ?? policy.conversationDays;
  const [choice, setChoice] = useState(choiceOf(target));
  useEffect(() => {
    setChoice(choiceOf(target));
  }, [target]);
  const days = daysOf(choice);
  const preview = useRetentionPreview(days);
  const period = (value: number) =>
    t(`privacy.retention.periods.d${value}` as 'privacy.retention.periods.d90');
  const changed = choice !== choiceOf(target);

  const submit = async (next: number | null, done: string) => {
    try {
      await save.mutateAsync({ conversationDays: next, version: policy.version });
      announce(done);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(days, t('privacy.retention.saved'));
  };

  return (
    <div className="flex flex-col gap-4">
      {policy.sweep.state === 'blocked' ? (
        <p
          data-testid="retention-blocked"
          className="flex items-start gap-2 rounded-lg border border-warning bg-surface-muted p-3 text-sm text-text"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          {t('privacy.retention.blocked')}
        </p>
      ) : null}
      {policy.pending ? (
        <div
          data-testid="retention-pending"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-muted p-3"
        >
          <p className="flex min-w-0 items-start gap-2 text-sm text-text">
            <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t('privacy.retention.pending', {
              date: formatDate(policy.pending.from),
              period: period(policy.pending.conversationDays),
            })}
          </p>
          <Button
            type="button"
            variant="secondary"
            busy={save.isPending}
            data-testid="retention-undo"
            onClick={() => void submit(policy.conversationDays, t('privacy.retention.undone'))}
          >
            {t('privacy.retention.undo')}
          </Button>
        </div>
      ) : null}
      <form className="flex max-w-md flex-col gap-4" onSubmit={onSubmit} noValidate>
        <SelectField
          id="retention-days"
          label={t('privacy.retention.label')}
          hint={t('privacy.retention.hint')}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          options={[
            { value: KEEP_FOREVER, label: t('privacy.retention.forever') },
            ...policy.choices.map((value) => ({ value: String(value), label: period(value) })),
          ]}
        />
        {days !== null ? (
          <p
            className="text-sm text-text-secondary"
            aria-live="polite"
            data-testid="retention-preview"
          >
            {preview.data
              ? t('privacy.retention.preview', { n: formatNumber(preview.data.conversations) })
              : t('privacy.retention.counting')}
          </p>
        ) : null}
        {changed ? (
          <p className="text-sm text-text" data-testid="retention-when">
            {deletesSooner(policy.conversationDays, days)
              ? t('privacy.retention.startsOn', {
                  date: preview.data ? formatDate(preview.data.deletesFrom) : '…',
                })
              : t('privacy.retention.atOnce')}
          </p>
        ) : null}
        <ActionError error={save.error && !isCancelled(save.error) ? save.error : null} />
        <div>
          <Button
            type="submit"
            busy={save.isPending}
            disabled={!changed}
            data-testid="retention-save"
          >
            {t('privacy.retention.save')}
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-1 text-sm text-text-secondary">
        {policy.sweep.state === 'running' ? <p>{t('privacy.retention.running')}</p> : null}
        {policy.sweep.conversationsDeleted + policy.sweep.customersDeleted > 0 ? (
          <p data-testid="retention-progress">
            {t('privacy.retention.progress', {
              conversations: formatNumber(policy.sweep.conversationsDeleted),
              customers: formatNumber(policy.sweep.customersDeleted),
            })}
          </p>
        ) : null}
        {policy.sweep.sweptAt ? (
          <p>{t('privacy.retention.checked', { date: formatDateTime(policy.sweep.sweptAt) })}</p>
        ) : null}
        <p>{t('privacy.retention.kept')}</p>
      </div>
    </div>
  );
}
