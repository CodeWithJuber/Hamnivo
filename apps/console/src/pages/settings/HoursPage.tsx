import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { PlusIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { BrandPicker } from '../../components/BrandPicker';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { api } from '../../lib/api';
import {
  ALL_DAY,
  bodyOfHours,
  type Day,
  dayName,
  draftOfHours,
  emptyWeek,
  type HoursDraft,
  type HoursProblem,
  MAX_CLOSED_DATES,
  MAX_SPANS,
  problemsOfHours,
  type Span,
  WEEK,
  WEEKDAYS,
  WORKING_SPAN,
  weekOf,
} from '../../lib/hours';
import { keys, useBrands, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { Brand } from '../../lib/types';
import { LeaveGuard } from './DiscardChangesDialog';
import { ReplyTargets } from './ReplyTargets';

/** The time zone of this browser: where a brand's hours start from when it has none. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Every time zone the browser knows, with the brand's own first when it is not among them. */
export function timeZones(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return known.includes(current) ? known : [current, ...known];
}

/** `2026-12-25` as "Friday, 25 December 2026" in the interface language. */
export function dateText(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(
      new Date(`${value}T00:00:00Z`),
    );
  } catch {
    return value;
  }
}

function problemText(
  problem: HoursProblem,
  t: TFunction,
  locale: string,
): { fieldId: string; message: string } {
  switch (problem.kind) {
    case 'time':
      return {
        fieldId: `hours-${problem.day}-${problem.index}-open`,
        message: t('setup.hours.problems.time', { day: dayName(problem.day, locale) }),
      };
    case 'order':
      return {
        fieldId: `hours-${problem.day}-${problem.index}-close`,
        message: t('setup.hours.problems.order', { day: dayName(problem.day, locale) }),
      };
    case 'overlap':
      return {
        fieldId: `hours-${problem.day}-0-open`,
        message: t('setup.hours.problems.overlap', { day: dayName(problem.day, locale) }),
      };
    case 'zone':
      return { fieldId: 'hours-zone', message: t('setup.hours.problems.zone') };
    case 'date':
      return { fieldId: 'hours-closed-new', message: t('setup.hours.problems.date') };
  }
}

function DayRow({
  day,
  spans,
  disabled,
  onChange,
}: {
  day: Day;
  spans: Span[];
  disabled: boolean;
  onChange: (spans: Span[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const name = dayName(day, i18n.language);
  const update = (index: number, patch: Partial<Span>) =>
    onChange(spans.map((span, i) => (i === index ? { ...span, ...patch } : span)));
  return (
    <fieldset
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      data-testid={`hours-day-${day}`}
      disabled={disabled}
    >
      <legend className="px-1 text-sm font-semibold text-text">{name}</legend>
      <CheckboxField
        id={`hours-${day}-open`}
        label={t('setup.hours.week.open')}
        checked={spans.length > 0}
        onCheckedChange={(on) => onChange(on ? [{ ...WORKING_SPAN }] : [])}
        disabled={disabled}
      />
      {spans.map((span, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: spans have no id; they are edited in place
        <div key={index} className="flex flex-wrap items-end gap-3">
          <TextField
            id={`hours-${day}-${index}-open`}
            label={t('setup.hours.week.opens')}
            type="time"
            value={span.open}
            dir="ltr"
            className="w-36"
            onChange={(event) => update(index, { open: event.target.value })}
          />
          <TextField
            id={`hours-${day}-${index}-close`}
            label={t('setup.hours.week.closes')}
            type="time"
            value={span.close}
            dir="ltr"
            className="w-36"
            onChange={(event) => update(index, { close: event.target.value })}
          />
          {spans.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('setup.hours.week.remove', { day: name })}
              onClick={() => onChange(spans.filter((_, i) => i !== index))}
              className="mb-0.5"
            >
              <XIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ))}
      {spans.length > 0 && spans.length < MAX_SPANS ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([...spans, { open: '18:00', close: '20:00' }])}
          >
            <PlusIcon aria-hidden="true" />
            {t('setup.hours.week.add')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

function ClosedDays({
  dates,
  disabled,
  onChange,
}: {
  dates: string[];
  disabled: boolean;
  onChange: (dates: string[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState('');
  const canAdd = value !== '' && !dates.includes(value) && dates.length < MAX_CLOSED_DATES;
  const add = () => {
    if (!canAdd) return;
    onChange([...dates, value].sort());
    setValue('');
  };
  return (
    <Section
      id="hours-closed"
      title={t('setup.hours.holidays.title')}
      description={t('setup.hours.holidays.description')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          id="hours-closed-new"
          label={t('setup.hours.holidays.date')}
          type="date"
          value={value}
          dir="ltr"
          className="w-48"
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="secondary" onClick={add} disabled={disabled || !canAdd}>
          <PlusIcon aria-hidden="true" />
          {t('setup.hours.holidays.add')}
        </Button>
      </div>
      {dates.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('setup.hours.holidays.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="closed-dates">
          {dates.map((date) => (
            <li
              key={date}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span>{dateText(date, i18n.language)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={t('setup.hours.holidays.remove', {
                  date: dateText(date, i18n.language),
                })}
                onClick={() => onChange(dates.filter((d) => d !== date))}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HoursEditor({ brand }: { brand: Brand }) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const saved = draftOfHours(brand.businessHours, browserZone());
  const [draft, setDraft] = useState<HoursDraft>(saved);
  const [attempted, setAttempted] = useState(false);
  const [removing, setRemoving] = useState(false);
  const editable = can('widget.configure');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useStudioMutation(
    (body: { businessHours: ReturnType<typeof bodyOfHours> | null }, tenant) =>
      api<Brand>(`/v1/admin/brands/${brand.id}/business-hours`, { method: 'PUT', body, tenant }),
    [keys.brands, keys.workspaces],
  );

  const problems = problemsOfHours(draft);
  const summary = attempted
    ? problems.map((problem) => problemText(problem, t, i18n.language))
    : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (problems.length > 0) return;
    try {
      await save.mutateAsync({ businessHours: bodyOfHours(draft) });
      announce(t('setup.hours.saved', { name: brand.name }));
    } catch {
      // Shown below the form.
    }
  };

  const preset = (weekly: Record<Day, Span[]>) => setDraft({ ...draft, weekly });

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate data-testid="hours-form">
      <LeaveGuard dirty={dirty} />
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <Section
        id="hours-week"
        title={t('setup.hours.week.title')}
        description={t('setup.hours.week.hint')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!editable}
              onClick={() => preset(weekOf(WEEKDAYS, [WORKING_SPAN]))}
            >
              {t('setup.hours.presets.weekdays')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!editable}
              onClick={() => preset(weekOf(WEEK, [ALL_DAY]))}
            >
              {t('setup.hours.presets.everyday')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!editable}
              onClick={() => preset(emptyWeek())}
            >
              {t('setup.hours.presets.closed')}
            </Button>
          </div>
        }
      >
        <SelectField
          id="hours-zone"
          label={t('setup.hours.timezone.label')}
          hint={t('setup.hours.timezone.hint')}
          value={draft.timezone}
          disabled={!editable}
          onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
          options={timeZones(draft.timezone).map((zone) => ({ value: zone, label: zone }))}
        />
        <div className="grid gap-3 md:grid-cols-2">
          {WEEK.map((day) => (
            <DayRow
              key={day}
              day={day}
              spans={draft.weekly[day]}
              disabled={!editable}
              onChange={(spans) =>
                setDraft({ ...draft, weekly: { ...draft.weekly, [day]: spans } })
              }
            />
          ))}
        </div>
      </Section>
      <ClosedDays
        dates={draft.closedDates}
        disabled={!editable}
        onChange={(closedDates) => setDraft({ ...draft, closedDates })}
      />
      <ActionError error={isCancelled(save.error) ? null : save.error} />
      {isCancelled(save.error) ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ReasonedAction reason={editable ? null : t('setup.hours.noPermission')}>
            <Button type="submit" busy={save.isPending} disabled={!dirty}>
              {t('setup.hours.save')}
            </Button>
          </ReasonedAction>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(saved);
              setAttempted(false);
            }}
          >
            {t('setup.hours.reset')}
          </Button>
          {dirty ? (
            <span className="text-sm text-text-secondary" data-testid="hours-unsaved">
              {t('setup.hours.unsaved')}
            </span>
          ) : null}
        </div>
        {brand.businessHours && editable ? (
          <Button type="button" variant="destructive" onClick={() => setRemoving(true)}>
            {t('setup.hours.remove.action')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('setup.hours.remove.title', { name: brand.name })}
        confirmLabel={t('setup.hours.remove.confirm')}
        variant="destructive-solid"
        onConfirm={async () => {
          await save.mutateAsync({ businessHours: null });
          announce(t('setup.hours.remove.done', { name: brand.name }));
        }}
      >
        <p>{t('setup.hours.remove.body')}</p>
      </ConfirmDialog>
    </form>
  );
}

/**
 * Business hours (W11): when the team answers, in the brand's own time zone, and the days it is
 * closed. Outside them the chat says honestly that nobody is online and when people are back; the
 * AI assistant answers at any hour. One brand at a time, chosen above.
 */
export function HoursPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const brands = useBrands();
  const search = useSearch({ from: '/_studio/hours' });
  const navigate = useNavigate({ from: '/hours' });
  const active = (brands.data?.items ?? []).filter((brand) => brand.status === 'active');
  const chosen = active.find((brand) => brand.id === search.brand) ?? active[0];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('setup.hours.title')} description={t('setup.hours.description')} />
      <QueryState
        query={brands}
        label={t('setup.hours.loading')}
        permitted={can('brands.manage')}
        isEmpty={() => active.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('setup.hours.noBrands.title')}
            description={t('setup.hours.noBrands.description')}
            action={
              <Button asChild>
                <Link to="/brands">{t('setup.hours.noBrands.action')}</Link>
              </Button>
            }
          />
        }
      >
        {() =>
          chosen ? (
            <div className="flex flex-col gap-6">
              <BrandPicker
                id="hours-brand"
                label={t('setup.brand')}
                brands={active.map((brand) => ({
                  id: brand.id,
                  name: brand.name,
                  status: brand.status,
                }))}
                value={chosen.id}
                onChange={(brandId) => navigate({ search: { brand: brandId } })}
              />
              <HoursEditor
                key={`${chosen.id}-${JSON.stringify(chosen.businessHours)}`}
                brand={chosen}
              />
              {can('inbox.manage') ? <ReplyTargets brand={chosen} /> : null}
            </div>
          ) : null
        }
      </QueryState>
    </div>
  );
}
