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
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PlusIcon, SendIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../components/AppDialog';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import {
  CheckboxField,
  ChoiceField,
  SelectField,
  TextareaField,
  TextField,
} from '../components/Fields';
import { PageHeader, Section } from '../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../components/States';
import { api, isApiError } from '../lib/api';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Items } from '../lib/types';

type DecisionTask = C.DecisionTask;
type DecisionRubric = C.DecisionRubric;
type DecisionRecord = C.DecisionRecord;
type RoutingTeam = C.RoutingTeam;
type LanguageSlice = C.LanguageSlice;
type DecisionMode = C.DecisionMode;
type TestResult = C.TestRubricResult;
type ExperimentReport = C.ExperimentReport;
type ExperimentSlice = ExperimentReport['overall'];
type Provider = DecisionRubric['provider'];
type RecordPage = { items: DecisionRecord[]; nextCursor: string | null };

const TASK = 'team-routing';
const SLICES: readonly LanguageSlice[] = ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'];
const MODES: readonly DecisionMode[] = ['off', 'shadow', 'live'];
const PROVIDERS: readonly Provider[] = ['none', 'jev', 'mock'];

const keysFor = (brandId: string) => ({
  task: ['decisions', brandId, 'task'] as const,
  teams: ['decisions', brandId, 'teams'] as const,
  records: ['decisions', brandId, 'records'] as const,
  experiment: ['decisions', brandId, 'experiment'] as const,
});
const taskPath = (brandId: string) => `/v1/admin/brands/${brandId}/decisions/${TASK}`;

/** "billing, shipping" → ["billing", "shipping"]. */
const splitList = (text: string) =>
  text
    .split(/[,،]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** Field messages from a failed save, by path (for example `definition.intents.0.key`). */
function fieldErrors(error: unknown): Map<string, string> {
  return new Map(isApiError(error) ? error.fields.map((f) => [f.path, f.message]) : []);
}

function useFormats() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  return {
    percent: (value: number | null | undefined) =>
      value === null || value === undefined
        ? '—'
        : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
            value,
          ),
    list: (items: string[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(items),
  };
}

const STATUS_TONE: Record<DecisionRecord['status'], StatusTone> = {
  decided: 'success',
  abstained: 'info',
  unavailable: 'warning',
  invalid: 'danger',
  skipped: 'neutral',
};

function StatusLabel({ status }: { status: DecisionRecord['status'] }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={STATUS_TONE[status]} data-status={status}>
      {t(`decisions.test.status.${status}`)}
    </StatusBadge>
  );
}

/** A topic key (always Latin letters) inside text of either direction. */
function Topic({ value }: { value: string | null | undefined }) {
  const { t } = useTranslation();
  if (!value) return <>{t('decisions.test.none')}</>;
  return (
    <bdi dir="ltr" className="font-mono text-[13px]">
      {value}
    </bdi>
  );
}

// ---------------------------------------------------------------------------------------------
// Mode (J02 shadow first)

function ModeSection({ brandId, task }: { brandId: string; task: DecisionTask }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [mode, setMode] = useState<DecisionMode>(task.mode);
  const save = useStudioMutation(
    (next: DecisionMode, tenant) =>
      api<DecisionTask>(`${taskPath(brandId)}/mode`, {
        method: 'PUT',
        tenant,
        body: { mode: next },
      }),
    [keysFor(brandId).task],
  );
  const manage = can('decisions.manage');
  const blocked = mode === 'live' && !task.published;
  return (
    <Section id="routing-mode" title={t('decisions.mode.title')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(mode, { onSuccess: () => announce(t('decisions.mode.saved')) });
        }}
      >
        <ChoiceField
          id="routing-mode-choice"
          legend={t('decisions.mode.legend')}
          value={mode}
          onValueChange={(value) => setMode(value as DecisionMode)}
          disabled={!manage}
          columns
          choices={MODES.map((value) => ({
            value,
            label: t(`decisions.mode.${value}`),
            hint:
              value === 'live' && !task.published
                ? t('decisions.mode.needsPublished')
                : t(`decisions.mode.${value}Hint`),
          }))}
        />
        <ActionError error={save.error} />
        {manage ? (
          <Button
            type="submit"
            className="self-start"
            busy={save.isPending}
            disabled={mode === task.mode || blocked}
          >
            {t('decisions.mode.save')}
          </Button>
        ) : null}
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Teams (J02, U07)

function TeamCard({ team }: { team: RoutingTeam }) {
  const { t } = useTranslation();
  const format = useFormats();
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm"
      data-testid="routing-team"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text">
          <bdi>{team.name}</bdi>
        </span>
        {team.isDefault ? (
          <StatusBadge tone="info">{t('decisions.teams.defaultBadge')}</StatusBadge>
        ) : null}
        <StatusBadge tone={team.accepting ? 'success' : 'neutral'}>
          {team.accepting ? t('decisions.teams.accepting') : t('decisions.teams.paused')}
        </StatusBadge>
      </div>
      <p className="text-text-secondary">
        {t('decisions.teams.topics')}:{' '}
        {team.intents.length > 0 ? (
          <bdi dir="ltr" className="font-mono text-[13px]">
            {team.intents.join(', ')}
          </bdi>
        ) : (
          t('decisions.teams.anyTopic')
        )}
      </p>
      <p className="text-text-secondary">
        {t('decisions.teams.languages')}:{' '}
        {team.languages.length > 0
          ? format.list(team.languages.map((slice) => t(`decisions.slices.${slice}`)))
          : t('decisions.teams.noLanguages')}
      </p>
    </li>
  );
}

function AddTeam({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [name, setName] = useState('');
  const [topics, setTopics] = useState('');
  const [languages, setLanguages] = useState<LanguageSlice[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const add = useStudioMutation(
    (body: object, tenant) =>
      api<RoutingTeam>(`/v1/admin/brands/${brandId}/routing/teams`, {
        method: 'POST',
        tenant,
        body,
      }),
    [keysFor(brandId).teams],
  );
  const errors = fieldErrors(add.error);
  const topicError = [...errors].find(([path]) => path.startsWith('intents'))?.[1];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      { name: name.trim(), intents: splitList(topics), languages, isDefault },
      {
        onSuccess: (team) => {
          announce(t('decisions.teams.added', { name: team.name }));
          setName('');
          setTopics('');
          setLanguages([]);
          setIsDefault(false);
        },
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-4 border-t border-border pt-4"
      onSubmit={submit}
      aria-labelledby="add-team-title"
    >
      <h3 id="add-team-title" className="text-md font-semibold text-text">
        {t('decisions.teams.add')}
      </h3>
      <TextField
        id="team-name"
        label={t('decisions.teams.name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        error={errors.get('name')}
      />
      <TextField
        id="team-topics"
        label={t('decisions.teams.topics')}
        hint={t('decisions.teams.topicsHint')}
        value={topics}
        onChange={(event) => setTopics(event.target.value)}
        dir="ltr"
        error={topicError}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-text">
          {t('decisions.teams.languages')}
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SLICES.map((slice) => (
            <CheckboxField
              key={slice}
              id={`team-language-${slice}`}
              label={t(`decisions.slices.${slice}`)}
              checked={languages.includes(slice)}
              onCheckedChange={(checked) =>
                setLanguages((current) =>
                  checked ? [...current, slice] : current.filter((s) => s !== slice),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <CheckboxField
        id="team-default"
        label={t('decisions.teams.isDefault')}
        hint={t('decisions.teams.isDefaultHint')}
        checked={isDefault}
        onCheckedChange={setIsDefault}
      />
      <ActionError error={add.error} />
      <Button type="submit" className="self-start" busy={add.isPending}>
        <PlusIcon aria-hidden="true" />
        {t('decisions.teams.add')}
      </Button>
    </form>
  );
}

function TeamsSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const teams = useStudioQuery<Items<RoutingTeam>>(
    keysFor(brandId).teams,
    `/v1/admin/brands/${brandId}/routing/teams`,
  );
  return (
    <Section
      id="routing-teams"
      title={t('decisions.teams.title')}
      description={t('decisions.teams.description')}
    >
      <QueryState
        query={teams}
        label={t('decisions.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('decisions.teams.empty')}</p>}
      >
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="routing-teams">
            {data.items.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </ul>
        )}
      </QueryState>
      {can('inbox.manage') ? (
        <AddTeam brandId={brandId} />
      ) : (
        <p className="text-sm text-text-secondary">{t('decisions.teams.noPermission')}</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Rubric editor (J05, HNV-12-01)

interface TopicRow {
  id: number;
  key: string;
  description: string;
  keywords: string;
}

function RubricSection({ brandId, task }: { brandId: string; task: DecisionTask }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const source = task.draft ?? task.published;
  const nextId = useRef(0);
  const row = (intent?: { key: string; description: string; keywords: string[] }): TopicRow => {
    nextId.current += 1;
    return {
      id: nextId.current,
      key: intent?.key ?? '',
      description: intent?.description ?? '',
      keywords: intent?.keywords.join(', ') ?? '',
    };
  };
  const [provider, setProvider] = useState<Provider>(source?.provider ?? 'none');
  const [model, setModel] = useState(source?.modelVersion ?? '');
  const [deadline, setDeadline] = useState(String(source?.deadlineMs ?? 1500));
  const [topics, setTopics] = useState<TopicRow[]>(() =>
    source ? source.definition.intents.map((intent) => row(intent)) : [row()],
  );
  const [recent, setRecent] = useState(String(source?.definition.inputs.recentMessages ?? 2));
  const [withStatus, setWithStatus] = useState(
    source?.definition.inputs.conversationStatus ?? true,
  );
  const [thresholds, setThresholds] = useState<Record<LanguageSlice, string>>(
    () =>
      Object.fromEntries(
        SLICES.map((slice) => [
          slice,
          source?.definition.thresholds[slice]?.minConfidence?.toString() ?? '',
        ]),
      ) as Record<LanguageSlice, string>,
  );
  const [confirming, setConfirming] = useState(false);
  const keys = keysFor(brandId);
  const save = useStudioMutation(
    (body: object, tenant) =>
      api<DecisionRubric>(`${taskPath(brandId)}/draft`, { method: 'PUT', tenant, body }),
    [keys.task],
  );
  const publish = useStudioMutation(
    (_: undefined, tenant) =>
      api<DecisionTask>(`${taskPath(brandId)}/publish`, { method: 'POST', tenant }),
    [keys.task],
  );
  const manage = can('decisions.manage');
  const errors = fieldErrors(save.error);
  const topicField = (index: number, field: string) =>
    errors.get(`definition.intents.${index}.${field}`);

  const body = () => ({
    definition: {
      intents: topics.map((topic) => ({
        key: topic.key.trim(),
        description: topic.description.trim(),
        keywords: splitList(topic.keywords),
      })),
      inputs: { recentMessages: Number(recent), conversationStatus: withStatus },
      thresholds: Object.fromEntries(
        SLICES.filter((slice) => thresholds[slice].trim() !== '').map((slice) => [
          slice,
          { minConfidence: Number(thresholds[slice]) },
        ]),
      ),
    },
    provider,
    modelVersion: model.trim() === '' ? null : model.trim(),
    deadlineMs: Number(deadline),
  });

  const update = (id: number, change: Partial<TopicRow>) =>
    setTopics((current) =>
      current.map((topic) => (topic.id === id ? { ...topic, ...change } : topic)),
    );

  return (
    <Section
      id="routing-rubric"
      title={t('decisions.rubric.title')}
      description={t('decisions.rubric.description')}
    >
      <div className="flex flex-wrap gap-2" data-testid="rubric-versions">
        <StatusBadge tone={task.published ? 'success' : 'neutral'}>
          {task.published
            ? t('decisions.rubric.publishedVersion', { version: task.published.version })
            : t('decisions.rubric.notPublished')}
        </StatusBadge>
        {task.draft ? (
          <StatusBadge tone="info">
            {t('decisions.rubric.draftVersion', { version: task.draft.version })}
          </StatusBadge>
        ) : null}
      </div>
      <form
        className="flex flex-col gap-6"
        aria-labelledby="routing-rubric-title"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(body(), { onSuccess: () => announce(t('decisions.rubric.saved')) });
        }}
      >
        <fieldset disabled={!manage} className="flex flex-col gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            <SelectField
              id="rubric-provider"
              label={t('decisions.rubric.provider')}
              value={provider}
              onChange={(event) => setProvider(event.target.value as Provider)}
              options={PROVIDERS.map((value) => ({
                value,
                label: t(`decisions.rubric.providers.${value}`),
              }))}
              error={errors.get('provider')}
            />
            <TextField
              id="rubric-model"
              label={t('decisions.rubric.model')}
              hint={t('decisions.rubric.modelHint')}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              dir="ltr"
              required={provider === 'jev'}
              error={errors.get('modelVersion')}
            />
            <TextField
              id="rubric-deadline"
              label={t('decisions.rubric.deadline')}
              hint={t('decisions.rubric.deadlineHint')}
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

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-md font-semibold text-text">
              {t('decisions.rubric.topics')}
            </legend>
            <p className="text-sm text-text-secondary">{t('decisions.rubric.otherNote')}</p>
            <ol className="flex flex-col gap-3" data-testid="rubric-topics">
              {topics.map((topic, index) => (
                <li key={topic.id}>
                  <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
                    <legend className="px-1 text-sm font-medium text-text">
                      {t('decisions.rubric.topicNumber', { number: index + 1 })}
                    </legend>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                      <TextField
                        id={`topic-${topic.id}-key`}
                        label={t('decisions.rubric.topicKey')}
                        hint={t('decisions.rubric.topicKeyHint')}
                        value={topic.key}
                        onChange={(event) => update(topic.id, { key: event.target.value })}
                        dir="ltr"
                        required
                        error={topicField(index, 'key')}
                      />
                      <TextField
                        id={`topic-${topic.id}-description`}
                        label={t('decisions.rubric.topicDescription')}
                        value={topic.description}
                        onChange={(event) => update(topic.id, { description: event.target.value })}
                        required
                        error={topicField(index, 'description')}
                      />
                    </div>
                    <TextField
                      id={`topic-${topic.id}-keywords`}
                      label={t('decisions.rubric.topicKeywords')}
                      hint={t('decisions.rubric.topicKeywordsHint')}
                      value={topic.keywords}
                      onChange={(event) => update(topic.id, { keywords: event.target.value })}
                      error={topicField(index, 'keywords')}
                    />
                    {topics.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="self-start"
                        onClick={() =>
                          setTopics((current) => current.filter((item) => item.id !== topic.id))
                        }
                        aria-label={t('decisions.rubric.removeTopic', { number: index + 1 })}
                      >
                        <Trash2Icon aria-hidden="true" />
                        {t('decisions.rubric.removeTopic', { number: index + 1 })}
                      </Button>
                    ) : null}
                  </fieldset>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="secondary"
              className="self-start"
              onClick={() => setTopics((current) => [...current, row()])}
            >
              <PlusIcon aria-hidden="true" />
              {t('decisions.rubric.addTopic')}
            </Button>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-md font-semibold text-text">
              {t('decisions.rubric.inputs')}
            </legend>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                id="rubric-recent"
                label={t('decisions.rubric.recentMessages')}
                hint={t('decisions.rubric.recentMessagesHint')}
                value={recent}
                onChange={(event) => setRecent(event.target.value)}
                type="number"
                inputMode="numeric"
                min={1}
                max={5}
                error={errors.get('definition.inputs.recentMessages')}
              />
              <CheckboxField
                id="rubric-status"
                label={t('decisions.rubric.conversationStatus')}
                checked={withStatus}
                onCheckedChange={setWithStatus}
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3" aria-describedby="rubric-thresholds-hint">
            <legend className="mb-1 text-md font-semibold text-text">
              {t('decisions.rubric.thresholds')}
            </legend>
            <p id="rubric-thresholds-hint" className="text-sm text-text-secondary">
              {t('decisions.rubric.thresholdsHint')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {SLICES.map((slice) => (
                <TextField
                  key={slice}
                  id={`threshold-${slice}`}
                  label={t('decisions.rubric.threshold', {
                    language: t(`decisions.slices.${slice}`),
                  })}
                  value={thresholds[slice]}
                  onChange={(event) =>
                    setThresholds((current) => ({ ...current, [slice]: event.target.value }))
                  }
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1}
                  step={0.05}
                  error={errors.get(`definition.thresholds.${slice}.minConfidence`)}
                />
              ))}
            </div>
          </fieldset>
        </fieldset>
        <ActionError error={save.error ?? publish.error} />
        {manage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={save.isPending}>
              {t('decisions.rubric.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!task.draft}
              onClick={() => setConfirming(true)}
            >
              <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
              {t('decisions.rubric.publish')}
            </Button>
            {!task.draft ? (
              <p className="self-center text-sm text-text-secondary">
                {t('decisions.rubric.noDraft')}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={setConfirming}
          title={t('decisions.rubric.publishTitle')}
          confirmLabel={t('decisions.rubric.publish')}
          testId="publish-rubric-dialog"
          onConfirm={async () => {
            const published = await publish.mutateAsync(undefined);
            announce(
              t('decisions.rubric.publishedNotice', {
                version: published.published?.version ?? '',
              }),
            );
          }}
        >
          <p>{t('decisions.rubric.publishBody')}</p>
        </ConfirmDialog>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Test panel (HNV-12-02 to HNV-12-05)

function TestResultCard({ result }: { result: TestResult }) {
  const { t } = useTranslation();
  const format = useFormats();
  const { record, policy } = result;
  return (
    <section
      aria-labelledby="test-result-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4 text-sm"
      data-testid="test-result"
      data-status={record.status}
    >
      <h3 id="test-result-title" className="text-md font-semibold text-text">
        {t('decisions.test.result')}
      </h3>
      {policy.explicitRequest ? (
        <p
          role="note"
          className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-text"
        >
          {t('decisions.test.explicit')}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <StatusLabel status={record.status} />
        <p className="text-text-secondary">{t(`decisions.test.statusHint.${record.status}`)}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt className="text-text-secondary">{t('decisions.test.providerTopic')}</dt>
        <dd>
          <Topic value={record.providerIntent} />
        </dd>
        <dt className="text-text-secondary">{t('decisions.test.confidence')}</dt>
        <dd data-testid="test-confidence">
          {record.confidence === null
            ? t('decisions.test.noConfidence')
            : format.percent(record.confidence)}
        </dd>
        <dt className="text-text-secondary">{t('decisions.test.baselineTopic')}</dt>
        <dd>
          <Topic value={record.baselineIntent} />
        </dd>
        <dt className="text-text-secondary">{t('decisions.test.finalTopic')}</dt>
        <dd data-testid="test-final">
          <Topic value={record.finalIntent} />{' '}
          <span className="text-text-secondary">
            (
            {record.finalSource === 'provider'
              ? t('decisions.test.fromProvider')
              : t('decisions.test.fromBaseline')}
            )
          </span>
        </dd>
        <dt className="text-text-secondary">{t('decisions.test.team')}</dt>
        <dd>{record.team ? <bdi>{record.team.name}</bdi> : t('decisions.test.noTeam')}</dd>
        {record.fallback ? (
          <>
            <dt className="text-text-secondary">{t('decisions.test.why')}</dt>
            <dd>{t(`decisions.test.fallback.${record.fallback as keyof typeof FALLBACKS}`)}</dd>
          </>
        ) : null}
        {policy.redacted.length > 0 ? (
          <>
            <dt className="sr-only">{t('decisions.rubric.inputs')}</dt>
            <dd className="col-span-2 text-text-secondary">
              {t('decisions.test.redacted', { kinds: format.list(policy.redacted) })}
            </dd>
          </>
        ) : null}
        <dt className="text-text-secondary">{t('decisions.test.time')}</dt>
        <dd>{formatDuration(record.totalMs ?? record.latencyMs)}</dd>
      </dl>
      <details className="text-text-secondary">
        <summary className="cursor-pointer">{t('decisions.test.detail')}</summary>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt>{t('decisions.test.request')}</dt>
          <dd>
            <bdi dir="ltr" className="font-mono text-xs">
              {record.requestId ?? record.id}
            </bdi>
          </dd>
          {record.reason ? (
            <>
              <dt>{t('decisions.test.why')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono text-xs">
                  {record.reason}
                </bdi>
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </section>
  );
}

/** Fallback reasons the test panel explains (the keys of decisions.test.fallback). */
const FALLBACKS = {
  not_asked: true,
  abstained: true,
  unavailable: true,
  invalid: true,
  label_not_offered: true,
} as const;

function TestSection({ brandId, task }: { brandId: string; task: DecisionTask }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [message, setMessage] = useState('');
  const [which, setWhich] = useState<'draft' | 'published'>(task.draft ? 'draft' : 'published');
  const keys = keysFor(brandId);
  const run = useStudioMutation(
    (body: object, tenant) =>
      api<TestResult>(`${taskPath(brandId)}/test`, { method: 'POST', tenant, body }),
    [keys.records, keys.experiment],
  );
  if (!can('decisions.manage')) return null;
  const available = (['draft', 'published'] as const).filter((kind) => task[kind] !== null);
  return (
    <Section
      id="routing-test"
      title={t('decisions.test.title')}
      description={t('decisions.test.description')}
    >
      {available.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('decisions.rubric.noDraft')}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          aria-labelledby="routing-test-title"
          onSubmit={(event) => {
            event.preventDefault();
            run.mutate({ rubric: which, message: message.trim() });
          }}
        >
          <TextareaField
            id="test-message"
            label={t('decisions.test.message')}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            required
            maxLength={1000}
          />
          {available.length > 1 ? (
            <ChoiceField
              id="test-rubric"
              legend={t('decisions.test.which')}
              value={which}
              onValueChange={(value) => setWhich(value as 'draft' | 'published')}
              choices={available.map((kind) => ({
                value: kind,
                label: t(`decisions.test.${kind}`),
              }))}
              columns
            />
          ) : null}
          <ActionError error={run.error} />
          <Button type="submit" className="self-start" busy={run.isPending}>
            {t('decisions.test.run')}
          </Button>
        </form>
      )}
      <div aria-live="polite">{run.data ? <TestResultCard result={run.data} /> : null}</div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Records and review (J07 records, HNV-12-06)

function ReviewDialog({
  record,
  brandId,
  onClose,
}: {
  record: DecisionRecord;
  brandId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const keys = keysFor(brandId);
  const [topic, setTopic] = useState(record.review?.intent ?? record.finalIntent);
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const review = useStudioMutation(
    (body: object, tenant) =>
      api<DecisionRecord>(`/v1/admin/decisions/${record.id}/review`, {
        method: 'POST',
        tenant,
        body,
      }),
    [keys.records, keys.experiment],
  );
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('decisions.review.title')}
      description={t('decisions.review.summary', {
        provider: record.providerIntent ?? t('decisions.test.none'),
        baseline: record.baselineIntent,
        final: record.finalIntent,
      })}
      testId="review-dialog"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          review.mutate(
            { intent: topic, reason: reason.trim(), trainingConsent: consent },
            {
              onSuccess: () => {
                announce(t('decisions.review.saved'));
                onClose();
              },
            },
          );
        }}
      >
        <SelectField
          id="review-topic"
          label={t('decisions.review.topic')}
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          options={record.offered.map((key) => ({ value: key, label: key }))}
          dir="ltr"
        />
        <TextareaField
          id="review-reason"
          label={t('decisions.review.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
          maxLength={500}
        />
        <CheckboxField
          id="review-consent"
          label={t('decisions.review.consent')}
          hint={t('decisions.review.consentHint')}
          checked={consent}
          onCheckedChange={setConsent}
        />
        <ActionError error={review.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={review.isPending}>
            {t('decisions.review.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function RecordsSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { tenantId, can } = useTenant();
  const format = useFormats();
  const [reviewing, setReviewing] = useState<DecisionRecord | null>(null);
  const records = useInfiniteQuery({
    queryKey: [tenantId, ...keysFor(brandId).records],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: '20' });
      if (pageParam) query.set('cursor', pageParam);
      return api<RecordPage>(`${taskPath(brandId)}/records?${query}`, { tenant: tenantId, signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { studio: true },
  });
  const items = records.data?.pages.flatMap((page) => page.items);
  const manage = can('decisions.manage');
  return (
    <Section
      id="routing-records"
      title={t('decisions.records.title')}
      description={t('decisions.records.description')}
    >
      <QueryState
        query={{
          data: items,
          error: records.error,
          isPending: records.isPending,
          isRefetching: records.isRefetching,
          refetch: records.refetch,
        }}
        label={t('decisions.loading')}
        isEmpty={(data) => data.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('decisions.records.empty')}</p>}
      >
        {(data) => (
          <Table data-testid="decision-records">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('decisions.records.time')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.trigger')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.jev')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.used')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.team')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.applied')}</TableHead>
                <TableHead className="text-start">{t('decisions.records.review')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((record) => (
                <TableRow key={record.id} data-testid="decision-record" data-status={record.status}>
                  <TableCell>{formatDateTime(record.createdAt)}</TableCell>
                  <TableCell>
                    {t(`decisions.records.triggers.${record.trigger}`)}
                    <span className="block text-xs text-text-secondary">
                      {t(`decisions.records.modes.${record.mode}`)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusLabel status={record.status} />
                    <span className="block text-xs text-text-secondary">
                      <Topic value={record.providerIntent} />
                      {record.confidence !== null ? ` · ${format.percent(record.confidence)}` : ''}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Topic value={record.finalIntent} />
                    <span className="block text-xs text-text-secondary">
                      {record.finalSource === 'provider'
                        ? t('decisions.test.fromProvider')
                        : t('decisions.test.fromBaseline')}
                    </span>
                  </TableCell>
                  <TableCell>
                    {record.team ? <bdi>{record.team.name}</bdi> : t('decisions.test.noTeam')}
                  </TableCell>
                  <TableCell>
                    {record.applied ? t('decisions.records.yes') : t('decisions.records.no')}
                  </TableCell>
                  <TableCell>
                    {record.review ? (
                      <span className="text-sm">
                        {t('decisions.records.reviewed', { topic: record.review.intent })}
                      </span>
                    ) : manage && record.mode !== 'test' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setReviewing(record)}
                        aria-label={t('decisions.records.reviewLabel', {
                          time: formatDateTime(record.createdAt),
                        })}
                      >
                        {t('decisions.records.reviewAction')}
                      </Button>
                    ) : (
                      t('decisions.test.none')
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
      {records.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          busy={records.isFetchingNextPage}
          onClick={() => void records.fetchNextPage()}
        >
          {t('decisions.records.more')}
        </Button>
      ) : null}
      {reviewing ? (
        <ReviewDialog record={reviewing} brandId={brandId} onClose={() => setReviewing(null)} />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Jev versus the fixed rules (J08)

function ExperimentRow({ label, slice }: { label: string; slice: ExperimentSlice }) {
  const { t } = useTranslation();
  const format = useFormats();
  const reviewed = (value: number | null) =>
    slice.reviewed === 0 ? t('decisions.experiment.notReviewed') : format.percent(value);
  return (
    <TableRow>
      <TableHead scope="row" className="text-start font-medium text-text">
        {label}
      </TableHead>
      <TableCell>{formatNumber(slice.records)}</TableCell>
      <TableCell>{format.percent(slice.agreement)}</TableCell>
      <TableCell>{reviewed(slice.providerAccuracy)}</TableCell>
      <TableCell>{reviewed(slice.baselineAccuracy)}</TableCell>
      <TableCell>{formatNumber(slice.abstained + slice.unavailable + slice.invalid)}</TableCell>
      <TableCell>
        {formatDuration(slice.latencyP50Ms)} / {formatDuration(slice.latencyP95Ms)}
      </TableCell>
      <TableCell>
        {formatNumber(slice.inputTokens)} / {formatNumber(slice.outputTokens)}
      </TableCell>
    </TableRow>
  );
}

function ExperimentSection({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const report = useStudioQuery<ExperimentReport>(
    keysFor(brandId).experiment,
    `${taskPath(brandId)}/experiment?days=30`,
  );
  const sliceLabel = (key: string) =>
    (SLICES as readonly string[]).includes(key)
      ? t(`decisions.slices.${key as LanguageSlice}`)
      : key;
  return (
    <Section
      id="routing-experiment"
      title={t('decisions.experiment.title')}
      description={t('decisions.experiment.description')}
    >
      <QueryState
        query={report}
        label={t('decisions.loading')}
        isEmpty={(data) => data.overall.records === 0}
        empty={<p className="text-sm text-text-secondary">{t('decisions.experiment.empty')}</p>}
      >
        {(data) => (
          <Table data-testid="decision-experiment">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('decisions.experiment.language')}</TableHead>
                <TableHead className="text-start">{t('decisions.experiment.decisions')}</TableHead>
                <TableHead className="text-start">{t('decisions.experiment.agreement')}</TableHead>
                <TableHead className="text-start">
                  {t('decisions.experiment.jevAccuracy')}
                </TableHead>
                <TableHead className="text-start">
                  {t('decisions.experiment.baselineAccuracy')}
                </TableHead>
                <TableHead className="text-start">{t('decisions.experiment.noAnswer')}</TableHead>
                <TableHead className="text-start">{t('decisions.experiment.time')}</TableHead>
                <TableHead className="text-start">{t('decisions.experiment.tokens')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <ExperimentRow label={t('decisions.experiment.all')} slice={data.overall} />
              {Object.entries(data.byLanguage).map(([key, slice]) => (
                <ExperimentRow key={key} label={sliceLabel(key)} slice={slice} />
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function BrandDecisions({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const task = useStudioQuery<DecisionTask>(keysFor(brandId).task, taskPath(brandId));
  return (
    <QueryState query={task} label={t('decisions.loading')}>
      {(data) => (
        <>
          <ModeSection key={`mode-${data.mode}`} brandId={brandId} task={data} />
          <TeamsSection brandId={brandId} />
          <RubricSection
            key={`rubric-${data.draft?.version ?? 0}-${data.published?.version ?? 0}`}
            brandId={brandId}
            task={data}
          />
          <TestSection brandId={brandId} task={data} />
          <RecordsSection brandId={brandId} />
          <ExperimentSection brandId={brandId} />
        </>
      )}
    </QueryState>
  );
}

/**
 * Decision rules (board 12, J02, J05, J08): routing teams, the rubric Jev decides with, a test
 * panel, recorded decisions with human review, and Jev compared with the fixed rules.
 */
export function DecisionsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/decisions' });
  const navigate = useNavigate({ from: '/decisions' });
  const { brands, active, chosen } = useChosenBrand(search.brand);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('decisions.title')} description={t('decisions.description')} />
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
          label={t('decisions.loading')}
          permitted={brands.permitted}
        >
          {() =>
            chosen ? (
              <>
                <BrandPicker
                  id="decisions-brand"
                  label={t('decisions.brand')}
                  brands={active}
                  value={chosen.id}
                  onChange={(brand) => void navigate({ search: { brand } })}
                />
                {!can('decisions.manage') ? (
                  <p className="text-sm text-text-secondary">{t('decisions.noManage')}</p>
                ) : null}
                <BrandDecisions key={chosen.id} brandId={chosen.id} />
              </>
            ) : (
              <p className="text-sm text-text-secondary">{t('decisions.noBrands')}</p>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
