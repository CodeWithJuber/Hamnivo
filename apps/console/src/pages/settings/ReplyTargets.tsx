import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { NativeSelect, NativeSelectOption } from '@hamnivo/ui/components/native-select';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { DOCS } from '../../lib/docs';
import { isCancelled } from '../../lib/reauth';
import {
  bodyOfTargets,
  draftOfTargets,
  problemsOfTargets,
  SLA_COLUMNS,
  SLA_PRIORITIES,
  type SlaColumn,
  type SlaPolicy,
  type SlaPriority,
  type TargetsDraft,
  useSaveSlaPolicy,
  useSlaPolicy,
} from '../../lib/sla';
import type { Brand } from '../../lib/types';

const COLUMN_TEXT = { firstReplyMinutes: 'firstReply', nextReplyMinutes: 'nextReply' } as const;

function TargetsForm({ brand, policy }: { brand: Brand; policy: SlaPolicy }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const save = useSaveSlaPolicy(brand.id);
  const saved = { enabled: policy.enabled, targets: draftOfTargets(policy.targets) };
  const [enabled, setEnabled] = useState(saved.enabled);
  const [draft, setDraft] = useState<TargetsDraft>(saved.targets);
  const [attempted, setAttempted] = useState(false);
  const dirty =
    enabled !== saved.enabled || JSON.stringify(draft) !== JSON.stringify(saved.targets);

  const problems = problemsOfTargets(draft);
  const invalid = (priority: SlaPriority, column: SlaColumn) =>
    attempted && problems.some((p) => p.priority === priority && p.column === column);
  const names = (priority: SlaPriority, column: SlaColumn) => ({
    column: t(`inbox.sla.settings.${COLUMN_TEXT[column]}`),
    priority: t(`inbox.tickets.priority.${priority}`),
  });
  const summary = attempted
    ? problems.map(({ priority, column }) => ({
        fieldId: `sla-${priority}-${column}`,
        message: t('inbox.sla.settings.invalid', names(priority, column)),
      }))
    : [];

  const set = (
    priority: SlaPriority,
    column: SlaColumn,
    patch: Partial<TargetsDraft[SlaPriority][SlaColumn]>,
  ) =>
    setDraft((prev) => ({
      ...prev,
      [priority]: { ...prev[priority], [column]: { ...prev[priority][column], ...patch } },
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (problems.length > 0) return;
    try {
      await save.mutateAsync({ enabled, targets: bodyOfTargets(draft) });
      setAttempted(false);
      announce(t('inbox.sla.settings.saved', { name: brand.name }));
    } catch {
      // Shown below the form.
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate data-testid="reply-targets">
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <CheckboxField
        id="sla-enabled"
        label={t('inbox.sla.settings.enabled')}
        hint={t('inbox.sla.settings.enabledHint')}
        checked={enabled}
        onCheckedChange={setEnabled}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {SLA_PRIORITIES.map((priority) => (
          <fieldset
            key={priority}
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            disabled={!enabled}
          >
            <legend className="px-1 text-sm font-semibold text-text">
              {t(`inbox.tickets.priority.${priority}`)}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {SLA_COLUMNS.map((column) => {
                const id = `sla-${priority}-${column}`;
                const value = draft[priority][column];
                const bad = invalid(priority, column);
                return (
                  <div key={column} className="flex min-w-0 flex-col gap-1.5">
                    <label htmlFor={id} className="text-sm font-medium text-text">
                      {t(`inbox.sla.settings.${COLUMN_TEXT[column]}`)}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={id}
                        inputMode="numeric"
                        autoComplete="off"
                        className="min-w-0 flex-1"
                        value={value.amount}
                        placeholder={t('inbox.sla.settings.empty')}
                        aria-label={t('inbox.sla.settings.amount', names(priority, column))}
                        aria-invalid={bad ? true : undefined}
                        onChange={(event) => set(priority, column, { amount: event.target.value })}
                        data-testid={id}
                      />
                      <NativeSelect
                        value={value.unit}
                        aria-label={t('inbox.sla.settings.unit', names(priority, column))}
                        onChange={(event) =>
                          set(priority, column, {
                            unit: event.target.value === 'hours' ? 'hours' : 'minutes',
                          })
                        }
                      >
                        <NativeSelectOption value="minutes">
                          {t('inbox.sla.settings.minutes')}
                        </NativeSelectOption>
                        <NativeSelectOption value="hours">
                          {t('inbox.sla.settings.hours')}
                        </NativeSelectOption>
                      </NativeSelect>
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="text-sm text-text-secondary">{t('inbox.sla.settings.noPriority')}</p>
      <ActionError error={isCancelled(save.error) ? null : save.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" busy={save.isPending} disabled={!dirty}>
          {t('inbox.sla.settings.save')}
        </Button>
        {dirty ? (
          <span className="text-sm text-text-secondary">{t('setup.hours.unsaved')}</span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Reply-time targets (H12) for one brand, under its business hours: how soon people should give
 * the first reply and each next one, by priority. Only for people who configure the inbox.
 */
export function ReplyTargets({ brand }: { brand: Brand }) {
  const { t } = useTranslation();
  const policy = useSlaPolicy(brand.id);
  return (
    <Section
      id="reply-targets"
      title={t('inbox.sla.settings.title')}
      description={t('inbox.sla.settings.description')}
      actions={
        <GuideLink href={DOCS.inbox.replyTargets}>{t('inbox.sla.settings.guide')}</GuideLink>
      }
    >
      <QueryState query={policy} label={t('inbox.sla.settings.loading')}>
        {(data) => (
          <TargetsForm
            key={`${brand.id}-${data.updatedAt ?? 'none'}`}
            brand={brand}
            policy={data}
          />
        )}
      </QueryState>
    </Section>
  );
}
