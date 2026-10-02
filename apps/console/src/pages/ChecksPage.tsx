import type * as C from '@hamnivo/contracts';
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
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import { ChoiceField, SelectField, TextField } from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../components/States';
import { api, isApiError } from '../lib/api';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Items } from '../lib/types';
import { JevNotConfigured } from './DecisionsPage';

type CheckTask = C.CheckTask;
type CheckRubric = C.CheckRubric;
type CheckRecord = C.CheckRecord;
type CheckQuestion = C.CheckQuestion;
type CheckThreshold = C.CheckThreshold;
type LanguageSlice = C.LanguageSlice;
type DecisionMode = C.DecisionMode;
type Provider = CheckRubric['provider'];

const SLICES: readonly LanguageSlice[] = ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'];
const MODES: readonly DecisionMode[] = ['off', 'shadow', 'live'];
const PROVIDERS: readonly Provider[] = ['none', 'jev', 'mock'];

const keysFor = (brandId: string) => ({
  list: ['checks', brandId, 'list'] as const,
  records: (task: string) => ['checks', brandId, 'records', task] as const,
});
const checksPath = (brandId: string) => `/v1/admin/brands/${brandId}/checks`;

/** Field messages from a failed save, by path (for example `thresholds.en.relation`). */
function fieldErrors(error: unknown): Map<string, string> {
  return new Map(isApiError(error) ? error.fields.map((f) => [f.path, f.message]) : []);
}

const VERDICTS = [
  'pass',
  'fail',
  'unsure',
  'abstained',
  'unavailable',
  'invalid',
  'drop',
  'keep',
  'escalate',
  'continue',
  'decided',
  'ask',
  'at_risk',
  'flagged',
  'clear',
  'unbacked',
] as const;
const ACTIONS = [
  'publish',
  'regenerate',
  'handoff',
  'drop',
  'keep',
  'continue',
  'use',
  'ask',
  'urgent',
] as const;
const known = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

const STATUS_TONE: Record<CheckRecord['status'], StatusTone> = {
  decided: 'success',
  abstained: 'info',
  unavailable: 'warning',
  invalid: 'danger',
  skipped: 'neutral',
};

/** Threshold inputs as typed: one or two text values per question and language. */
type ThresholdInputs = Record<string, { min: string; yes: string; no: string }>;
const inputKey = (slice: LanguageSlice, key: string) => `${slice}:${key}`;
const show = (value: number | undefined) => (value === undefined ? '' : String(value));

function toInputs(thresholds: C.CheckThresholds, questions: CheckQuestion[]): ThresholdInputs {
  const inputs: ThresholdInputs = {};
  for (const slice of SLICES) {
    for (const q of questions) {
      const t = thresholds[slice]?.[q.key];
      inputs[inputKey(slice, q.key)] = {
        min: show(t?.type === 'choice' ? t.minConfidence : undefined),
        yes: show(t?.type === 'noul' ? t.trueAtLeast : undefined),
        no: show(t?.type === 'noul' ? t.falseAtMost : undefined),
      };
    }
  }
  return inputs;
}

/** Only languages and questions with values are sent: an empty language is not evaluated. */
function fromInputs(inputs: ThresholdInputs, questions: CheckQuestion[]): C.CheckThresholds {
  const out: Partial<Record<LanguageSlice, Record<string, CheckThreshold>>> = {};
  for (const slice of SLICES) {
    for (const q of questions) {
      const value = inputs[inputKey(slice, q.key)];
      if (!value) continue;
      let threshold: CheckThreshold | null = null;
      if (q.type === 'choice' && value.min.trim() !== '') {
        threshold = { type: 'choice', minConfidence: Number(value.min) };
      }
      if (q.type === 'noul' && (value.yes.trim() !== '' || value.no.trim() !== '')) {
        threshold = {
          type: 'noul',
          trueAtLeast: Number(value.yes || 1),
          falseAtMost: Number(value.no || 0),
        };
      }
      if (threshold) out[slice] = { ...(out[slice] ?? {}), [q.key]: threshold };
    }
  }
  return out;
}

function ModeForm({ brandId, task }: { brandId: string; task: CheckTask }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [mode, setMode] = useState<DecisionMode>(task.mode);
  const save = useStudioMutation(
    (next: DecisionMode, tenant) =>
      api<CheckTask>(`${checksPath(brandId)}/${task.task}/mode`, {
        method: 'PUT',
        tenant,
        body: { mode: next },
      }),
    [keysFor(brandId).list],
  );
  const manage = can('decisions.manage');
  const id = `check-${task.task}-mode`;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(mode, { onSuccess: () => announce(t('checks.mode.saved')) });
      }}
    >
      <ChoiceField
        id={id}
        legend={t('checks.mode.legend')}
        value={mode}
        onValueChange={(value) => setMode(value as DecisionMode)}
        disabled={!manage}
        columns
        choices={MODES.map((value) => ({
          value,
          label: t(`checks.mode.${value}`),
          hint:
            value === 'live' && !task.published
              ? t('checks.mode.needsPublished')
              : t(`checks.mode.${value}Hint`),
        }))}
      />
      <ActionError error={save.error} />
      {manage ? (
        <Button
          type="submit"
          variant="secondary"
          className="self-start"
          busy={save.isPending}
          disabled={mode === task.mode || (mode === 'live' && !task.published)}
        >
          {t('checks.mode.save')}
        </Button>
      ) : null}
    </form>
  );
}

function Questions({ questions }: { questions: CheckQuestion[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-text">{t('checks.questions.title')}</h3>
      <p className="text-sm text-text-secondary">{t('checks.questions.hint')}</p>
      <ul className="flex flex-col gap-2">
        {questions.map((q) => (
          <li
            key={q.key}
            className="rounded-lg border border-border bg-surface-sunken p-3 text-sm"
            dir="ltr"
            lang="en"
          >
            <p className="font-medium text-text">{q.instructions}</p>
            <ul className="mt-1 list-disc ps-5 text-text-secondary">
              {Object.entries(q.options).map(([option, description]) => (
                <li key={option}>
                  <span className="font-mono text-[13px]">{option}</span>
                  {description ? `: ${description}` : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RubricForm({ brandId, task }: { brandId: string; task: CheckTask }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const source = task.draft ?? task.published;
  const [provider, setProvider] = useState<Provider>(source?.provider ?? 'none');
  const [model, setModel] = useState(source?.modelVersion ?? '');
  const [deadline, setDeadline] = useState(String(source?.deadlineMs ?? 1500));
  const [inputs, setInputs] = useState<ThresholdInputs>(() =>
    toInputs(source?.thresholds ?? {}, task.questions),
  );
  const [evaluatedFill, setEvaluatedFill] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const keys = keysFor(brandId);
  const path = `${checksPath(brandId)}/${task.task}`;
  const save = useStudioMutation(
    (body: object, tenant) => api<CheckRubric>(`${path}/draft`, { method: 'PUT', tenant, body }),
    [keys.list],
  );
  const publish = useStudioMutation(
    (_: undefined, tenant) => api<CheckTask>(`${path}/publish`, { method: 'POST', tenant }),
    [keys.list],
  );
  const manage = can('decisions.manage');
  const errors = fieldErrors(save.error);
  const id = (suffix: string) => `check-${task.task}-${suffix}`;

  /** Choosing Jev with no model pins the version Hamnivo evaluated and fills its thresholds. */
  const chooseProvider = (next: Provider) => {
    setProvider(next);
    if (next !== 'jev' || model.trim() !== '') return;
    setModel(task.jev.recommendedModel);
    const measured = toInputs(task.recommendedThresholds, task.questions);
    const merged = { ...inputs };
    let filled = false;
    for (const [key, value] of Object.entries(measured)) {
      const now = merged[key];
      const empty = !now || (now.min === '' && now.yes === '' && now.no === '');
      if (empty && (value.min || value.yes || value.no)) {
        merged[key] = value;
        filled = true;
      }
    }
    if (!filled) return;
    setInputs(merged);
    setEvaluatedFill(true);
  };

  const setInput = (key: string, field: 'min' | 'yes' | 'no', value: string) =>
    setInputs((current) => ({
      ...current,
      [key]: { ...(current[key] ?? { min: '', yes: '', no: '' }), [field]: value },
    }));

  return (
    <form
      className="flex flex-col gap-6"
      aria-labelledby={id('rubric-title')}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(
          {
            provider,
            modelVersion: model.trim() === '' ? null : model.trim(),
            deadlineMs: Number(deadline),
            thresholds: fromInputs(inputs, task.questions),
          },
          { onSuccess: () => announce(t('checks.rubric.saved')) },
        );
      }}
    >
      <h3 id={id('rubric-title')} className="text-md font-semibold text-text">
        {t('checks.rubric.title')}
      </h3>
      <fieldset disabled={!manage} className="flex flex-col gap-6">
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField
            id={id('provider')}
            label={t('checks.rubric.provider')}
            value={provider}
            onChange={(event) => chooseProvider(event.target.value as Provider)}
            options={PROVIDERS.map((value) => ({
              value,
              label: t(`checks.rubric.providers.${value}`),
            }))}
          />
          <TextField
            id={id('model')}
            label={t('checks.rubric.model')}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            dir="ltr"
            error={errors.get('modelVersion')}
          />
          <TextField
            id={id('deadline')}
            label={t('checks.rubric.deadline')}
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
            type="number"
            inputMode="numeric"
            min={100}
            max={10000}
            step={100}
            error={errors.get('deadlineMs')}
          />
        </div>
        {provider === 'jev' && !task.jev.configured ? <JevNotConfigured /> : null}
        <fieldset className="flex flex-col gap-3" aria-describedby={id('thresholds-hint')}>
          <legend className="mb-1 text-md font-semibold text-text">
            {t('checks.rubric.thresholds')}
          </legend>
          <p id={id('thresholds-hint')} className="text-sm text-text-secondary">
            {t('checks.rubric.thresholdsHint')}
          </p>
          {evaluatedFill ? (
            <p className="text-sm text-text-secondary" data-testid="check-thresholds-evaluated">
              {t('checks.rubric.evaluated', { model: task.jev.recommendedModel })}
            </p>
          ) : null}
          {task.questions.map((q) => (
            <details
              key={q.key}
              className="rounded-lg border border-border p-3"
              open={task.questions.length === 1}
            >
              <summary className="cursor-pointer text-sm font-medium text-text">
                <bdi dir="ltr" className="font-mono text-[13px]">
                  {q.key}
                </bdi>
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {SLICES.flatMap((slice) => {
                  const key = inputKey(slice, q.key);
                  const value = inputs[key] ?? { min: '', yes: '', no: '' };
                  const language = t(`decisions.slices.${slice}`);
                  const number = {
                    type: 'number' as const,
                    inputMode: 'decimal' as const,
                    min: 0,
                    max: 1,
                    step: 0.05,
                  };
                  const error = errors.get(`thresholds.${slice}.${q.key}`);
                  return q.type === 'choice'
                    ? [
                        <TextField
                          key={`${key}-min`}
                          id={id(`${q.key}-${slice}-min`)}
                          label={t('checks.rubric.minConfidence', { language, question: q.key })}
                          value={value.min}
                          onChange={(event) => setInput(key, 'min', event.target.value)}
                          error={error}
                          {...number}
                        />,
                      ]
                    : [
                        <TextField
                          key={`${key}-yes`}
                          id={id(`${q.key}-${slice}-yes`)}
                          label={t('checks.rubric.trueAtLeast', { language, question: q.key })}
                          value={value.yes}
                          onChange={(event) => setInput(key, 'yes', event.target.value)}
                          error={error}
                          {...number}
                        />,
                        <TextField
                          key={`${key}-no`}
                          id={id(`${q.key}-${slice}-no`)}
                          label={t('checks.rubric.falseAtMost', { language, question: q.key })}
                          value={value.no}
                          onChange={(event) => setInput(key, 'no', event.target.value)}
                          {...number}
                        />,
                      ];
                })}
              </div>
            </details>
          ))}
        </fieldset>
      </fieldset>
      <ActionError error={save.error ?? publish.error} />
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={save.isPending}>
            {t('checks.rubric.save')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!task.draft}
            onClick={() => setConfirming(true)}
          >
            {t('checks.rubric.publish')}
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={setConfirming}
          title={t('checks.rubric.publishTitle')}
          confirmLabel={t('checks.rubric.publish')}
          testId={`publish-check-${task.task}`}
          onConfirm={async () => {
            const published = await publish.mutateAsync(undefined);
            announce(
              t('checks.rubric.publishedNotice', { version: published.published?.version ?? '' }),
            );
          }}
        >
          <p className="text-sm text-text">{t('checks.rubric.publishBody')}</p>
        </ConfirmDialog>
      ) : null}
    </form>
  );
}

function Records({ brandId, task }: { brandId: string; task: CheckTask }) {
  const { t } = useTranslation();
  const records = useStudioQuery<{ items: CheckRecord[] }>(
    keysFor(brandId).records(task.task),
    `${checksPath(brandId)}/${task.task}/records?limit=20`,
  );
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-text">{t('checks.records.title')}</h3>
      <QueryState query={records} label={t('checks.loading')}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('checks.records.empty')}</p>
          ) : (
            <Table data-testid={`check-records-${task.task}`}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('checks.records.time')}</TableHead>
                  <TableHead>{t('checks.records.mode')}</TableHead>
                  <TableHead>{t('checks.records.status')}</TableHead>
                  <TableHead>{t('checks.records.verdict')}</TableHead>
                  <TableHead>{t('checks.records.action')}</TableHead>
                  <TableHead>{t('checks.records.latency')}</TableHead>
                  <TableHead>{t('checks.records.tokens')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((record) => (
                  <TableRow key={record.id} data-testid="check-record">
                    <TableCell>{formatDateTime(record.createdAt)}</TableCell>
                    <TableCell>
                      {record.mode === 'test'
                        ? t('checks.records.test')
                        : t(`checks.mode.${record.mode}`)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[record.status]} data-status={record.status}>
                        {t(`decisions.test.status.${record.status}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell data-verdict={record.verdict}>
                      {known(VERDICTS, record.verdict)
                        ? t(`checks.verdict.${record.verdict}`)
                        : record.verdict}
                    </TableCell>
                    <TableCell data-action={record.action} data-applied={record.applied}>
                      {known(ACTIONS, record.action)
                        ? t(`checks.action.${record.action}`)
                        : record.action}
                      {record.applied ? '' : ` (${t('checks.records.notApplied')})`}
                    </TableCell>
                    <TableCell>{formatDuration(record.latencyMs)}</TableCell>
                    <TableCell>{formatNumber(record.inputTokens)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </QueryState>
    </div>
  );
}

function CheckSection({ brandId, task }: { brandId: string; task: CheckTask }) {
  const { t } = useTranslation();
  return (
    <Section
      id={`check-${task.task}`}
      title={t(`checks.task.${task.task}.title`)}
      description={t(`checks.task.${task.task}.description`)}
    >
      <div className="flex flex-wrap gap-2" data-testid={`check-versions-${task.task}`}>
        <StatusBadge tone={task.published ? 'success' : 'neutral'}>
          {task.published
            ? t('checks.versions.published', { version: task.published.version })
            : t('checks.versions.notPublished')}
        </StatusBadge>
        {task.draft ? (
          <StatusBadge tone="info">
            {t('checks.versions.draft', { version: task.draft.version })}
          </StatusBadge>
        ) : null}
      </div>
      <ModeForm key={`mode-${task.mode}`} brandId={brandId} task={task} />
      <Questions questions={task.questions} />
      <RubricForm
        key={`rubric-${task.draft?.version ?? 0}-${task.published?.version ?? 0}`}
        brandId={brandId}
        task={task}
      />
      <Records brandId={brandId} task={task} />
    </Section>
  );
}

function BrandChecks({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const list = useStudioQuery<Items<CheckTask>>(keysFor(brandId).list, checksPath(brandId));
  return (
    <QueryState query={list} label={t('checks.loading')}>
      {(data) => (
        <>
          {data.items.map((task) => (
            <CheckSection key={task.task} brandId={brandId} task={task} />
          ))}
        </>
      )}
    </QueryState>
  );
}

/**
 * Reply checks: what Jev checks around AI replies, per brand. Every check starts in shadow mode
 * (recorded only); live mode acts on it. Thresholds are set per language, from what shadow mode
 * recorded or from Hamnivo's evaluation.
 */
export function ChecksPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/checks' });
  const navigate = useNavigate({ from: '/checks' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('checks.title')} description={t('checks.description')} />
      {!can('decisions.read') ? (
        <Forbidden />
      ) : (
        <QueryState
          query={{
            data: brands.items,
            error: brands.error,
            isPending: brands.pending,
            isRefetching: brands.isRefetching,
            refetch: brands.refetch,
          }}
          label={t('checks.loading')}
          permitted={brands.permitted}
        >
          {() =>
            chosen ? (
              <>
                <BrandPicker
                  id="checks-brand"
                  label={t('checks.brand')}
                  brands={active}
                  value={chosen.id}
                  onChange={(brand) => void navigate({ search: { brand } })}
                />
                {!can('decisions.manage') ? (
                  <p className="text-sm text-text-secondary">{t('checks.noManage')}</p>
                ) : null}
                <BrandChecks key={chosen.id} brandId={chosen.id} />
              </>
            ) : (
              <p className="text-sm text-text-secondary">{t('checks.noBrands')}</p>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
