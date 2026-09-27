import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@hamnivo/ui/components/sheet';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { ActivityIcon, ListFilterIcon, XIcon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OutcomeBadge, outcomeOf, StepStatusBadge } from '../components/Badges';
import { SelectField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { QueryState } from '../components/States';
import { directionOf, isLocale } from '../i18n';
import { returnFocus, useOpener } from '../lib/focus';
import { formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { type Names, useNames } from '../lib/names';
import { useAgents, useRun, useRuns } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { Run, RunStep } from '../lib/types';
import type { RunsSearch } from '../routes/_studio/runs';

const OUTCOMES = [
  'replied',
  'drafted',
  'handoff',
  'fenced',
  'blocked',
  'error',
  'skipped',
  'running',
] as const;

const EMPTY: Run[] = [];
const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Run>();

function agentLabel(t: TFunction, names: Names, run: Run) {
  const name = names.agent(run.agentId) ?? (run.agentId ? run.agentId : t('runs.detail.noAgent'));
  return run.agentVersion
    ? `${name} · ${t('runs.detail.version', { version: run.agentVersion })}`
    : name;
}

function DetailValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  if (typeof value === 'object') {
    return <code className="hv-code block text-xs">{JSON.stringify(value, null, 2)}</code>;
  }
  return (
    <bdi dir="ltr" className="font-mono text-xs">
      {String(value)}
    </bdi>
  );
}

function StepItem({ step }: { step: RunStep }) {
  const { t } = useTranslation();
  const facts = Object.entries(step.detail);
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-step-kind={step.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">
          {t('runs.detail.step', { n: step.seq + 1 })}
        </span>
        <StatusBadge tone="neutral" icon={null}>
          {t(`runs.detail.stepKinds.${step.kind}`)}
        </StatusBadge>
        <StepStatusBadge status={step.status} />
      </div>
      <p className="font-medium text-text">
        <bdi dir="ltr">{step.name}</bdi>
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {step.provider || step.modelId ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.model')}</dt>
            <dd>
              <bdi dir="ltr" className="font-mono text-xs">
                {[step.provider, step.modelId].filter(Boolean).join(' / ')}
              </bdi>
            </dd>
          </>
        ) : null}
        {step.inputTokens !== null || step.outputTokens !== null ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.tokens')}</dt>
            <dd>
              {formatNumber(step.inputTokens)} / {formatNumber(step.outputTokens)}
            </dd>
          </>
        ) : null}
        {step.latencyMs !== null ? (
          <>
            <dt className="text-text-secondary">{t('runs.columns.latency')}</dt>
            <dd>{formatDuration(step.latencyMs)}</dd>
          </>
        ) : null}
        {facts.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-text-secondary">
              <bdi dir="ltr" className="font-mono text-xs">
                {key}
              </bdi>
            </dt>
            <dd className="min-w-0">
              <DetailValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
      {facts.length === 0 && !step.provider && step.latencyMs === null ? (
        <p className="text-xs text-text-secondary">{t('runs.detail.noDetail')}</p>
      ) : null}
    </li>
  );
}

function RunDetail({ runId, names }: { runId: string; names: Names }) {
  const { t } = useTranslation();
  const run = useRun(runId);
  return (
    <QueryState query={run} label={t('runs.detail.loading')}>
      {(data) => (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeBadge run={data} />
            <StatusBadge tone={data.state === 'failed' ? 'danger' : 'neutral'} icon={null}>
              {t(`runs.detail.states.${data.state}`)}
            </StatusBadge>
          </div>
          <section aria-labelledby="run-summary" className="flex flex-col gap-2">
            <h3 id="run-summary" className="text-sm font-semibold text-text">
              {t('runs.detail.summary')}
            </h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-text-secondary">{t('runs.detail.kind')}</dt>
              <dd>{t(`runs.detail.kinds.${data.kind}`)}</dd>
              <dt className="text-text-secondary">{t('runs.columns.agent')}</dt>
              <dd>
                <bdi>{agentLabel(t, names, data)}</bdi>
              </dd>
              <dt className="text-text-secondary">{t('runs.columns.model')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono text-xs">
                  {[data.provider, data.modelId].filter(Boolean).join(' / ') || '—'}
                </bdi>
              </dd>
              <dt className="text-text-secondary">{t('runs.columns.tokens')}</dt>
              <dd>
                {formatNumber(data.inputTokens)} / {formatNumber(data.outputTokens)}
              </dd>
              <dt className="text-text-secondary">{t('runs.columns.latency')}</dt>
              <dd>{formatDuration(data.latencyMs)}</dd>
              <dt className="text-text-secondary">{t('runs.detail.started')}</dt>
              <dd>{formatDateTime(data.startedAt)}</dd>
              <dt className="text-text-secondary">{t('runs.detail.finished')}</dt>
              <dd>{data.finishedAt ? formatDateTime(data.finishedAt) : '—'}</dd>
              <dt className="text-text-secondary">{t('runs.detail.conversation')}</dt>
              <dd className="min-w-0 break-all">
                <bdi dir="ltr" className="font-mono text-xs">
                  {data.conversationId}
                </bdi>
              </dd>
              {data.errorKind ? (
                <>
                  <dt className="text-text-secondary">{t('runs.detail.errorKind')}</dt>
                  <dd>
                    <bdi dir="ltr" className="font-mono text-xs">
                      {data.errorKind}
                    </bdi>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
          <section aria-labelledby="run-steps" className="flex flex-col gap-2">
            <h3 id="run-steps" className="text-sm font-semibold text-text">
              {t('runs.detail.steps')}
            </h3>
            {(data.steps ?? []).length === 0 ? (
              <p className="text-sm text-text-secondary">{t('runs.detail.noSteps')}</p>
            ) : (
              <ol className="flex flex-col gap-2" data-testid="run-steps">
                {(data.steps ?? []).map((step) => (
                  <StepItem key={step.seq} step={step} />
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </QueryState>
  );
}

/** Run telemetry (G12, X11): outcome, version, model, tokens and time, never message text. */
export function RunsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/runs' });
  const names = useNames();
  const agents = useAgents();
  const runs = useRuns({ agentId: search.agent, conversationId: search.conversation });
  const [agent, setAgent] = useState(search.agent ?? '');
  const [outcome, setOutcome] = useState(search.outcome ?? '');
  const [conversation, setConversation] = useState(search.conversation ?? '');
  const dir = directionOf(isLocale(i18n.language) ? i18n.language : 'en');
  const runOpener = useOpener(Boolean(search.run));

  useEffect(() => {
    setAgent(search.agent ?? '');
    setOutcome(search.outcome ?? '');
    setConversation(search.conversation ?? '');
  }, [search.agent, search.outcome, search.conversation]);

  const loaded = useMemo(
    () => runs.data?.pages.flatMap((page) => page.items) ?? EMPTY,
    [runs.data],
  );
  // The gateway filters by agent and conversation; the outcome filter applies to loaded runs.
  const rows = useMemo(
    () => (search.outcome ? loaded.filter((run) => outcomeOf(run) === search.outcome) : loaded),
    [loaded, search.outcome],
  );
  const filtered = Boolean(search.agent || search.outcome || search.conversation);

  const closeRun = () =>
    navigate({
      to: '/runs',
      search: (prev: RunsSearch) => {
        const { run: _closed, ...rest } = prev;
        return rest;
      },
    });

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor('startedAt', {
          header: () => t('runs.columns.started'),
          cell: (info) => (
            <time dateTime={info.getValue()} className="whitespace-nowrap">
              {formatDateTime(info.getValue())}
            </time>
          ),
        }),
        helper.accessor('outcome', {
          header: () => t('runs.columns.outcome'),
          cell: (info) => <OutcomeBadge run={info.row.original} />,
        }),
        helper.accessor('agentId', {
          header: () => t('runs.columns.agent'),
          cell: (info) => <bdi>{agentLabel(t, names, info.row.original)}</bdi>,
        }),
        helper.accessor('modelId', {
          header: () => t('runs.columns.model'),
          cell: (info) => (
            <bdi dir="ltr" className="font-mono text-xs">
              {[info.row.original.provider, info.getValue()].filter(Boolean).join(' / ') || '—'}
            </bdi>
          ),
        }),
        helper.accessor('inputTokens', {
          header: () => t('runs.columns.tokens'),
          cell: (info) =>
            `${formatNumber(info.getValue())} / ${formatNumber(info.row.original.outputTokens)}`,
        }),
        helper.accessor('latencyMs', {
          header: () => t('runs.columns.latency'),
          cell: (info) => formatDuration(info.getValue()),
        }),
        helper.display({
          id: 'details',
          header: () => t('runs.columns.details'),
          cell: (info) => (
            <Button asChild variant="secondary" size="sm">
              <Link
                to="/runs"
                search={(prev: RunsSearch) => ({ ...prev, run: info.row.original.id })}
                aria-label={t('runs.viewLabel', {
                  time: formatDateTime(info.row.original.startedAt),
                })}
                data-testid="view-run"
              >
                {t('runs.view')}
              </Link>
            </Button>
          ),
        }),
      ]),
    [t, names],
  );

  const table = useTable({ features, columns, data: rows, getRowId: (run) => run.id });

  const apply = (event: FormEvent) => {
    event.preventDefault();
    void navigate({
      to: '/runs',
      search: {
        ...(agent ? { agent } : {}),
        ...(outcome ? { outcome } : {}),
        ...(conversation.trim() ? { conversation: conversation.trim() } : {}),
      },
    });
  };

  const reset = () => void navigate({ to: '/runs', search: {} });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('runs.title')} description={t('runs.description')} />
      <form
        onSubmit={apply}
        aria-labelledby="runs-filters"
        className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm"
      >
        <h2 id="runs-filters" className="flex items-center gap-2 text-md font-semibold text-text">
          <ListFilterIcon className="size-4 text-text-muted" aria-hidden="true" />
          {t('runs.filters.label')}
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField
            id="runs-agent"
            label={t('runs.filters.agent')}
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            options={[
              { value: '', label: t('runs.filters.allAgents') },
              ...(agents.data?.items ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <SelectField
            id="runs-outcome"
            label={t('runs.filters.outcome')}
            hint={t('runs.filters.outcomeNote')}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            options={[
              { value: '', label: t('runs.filters.allOutcomes') },
              ...OUTCOMES.map((value) => ({ value, label: t(`runs.outcome.${value}`) })),
            ]}
          />
          <TextField
            id="runs-conversation"
            label={t('runs.filters.conversation')}
            hint={t('runs.filters.conversationHint')}
            value={conversation}
            dir="ltr"
            spellCheck={false}
            onChange={(event) => setConversation(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{t('runs.filters.apply')}</Button>
          {filtered ? (
            <Button type="button" variant="secondary" onClick={reset}>
              {t('runs.filters.reset')}
            </Button>
          ) : null}
        </div>
      </form>

      <QueryState
        query={{ ...runs, data: runs.data ? rows : undefined }}
        label={t('runs.loading')}
        permitted={can('analytics.read')}
        isEmpty={(items) => items.length === 0}
        empty={
          filtered ? (
            <EmptyState
              kind="no-matches"
              title={t('runs.noMatches.title')}
              description={t('runs.noMatches.description')}
              action={
                <Button variant="secondary" onClick={reset}>
                  {t('runs.filters.reset')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              kind="no-records"
              title={t('runs.empty.title')}
              description={t('runs.empty.description')}
              icon={<ActivityIcon className="size-6 text-text-muted" aria-hidden="true" />}
              action={
                <Button asChild variant="secondary">
                  <Link to="/agents">{t('runs.empty.action')}</Link>
                </Button>
              }
            />
          )
        }
      >
        {() => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary" role="status">
              {t('runs.shown', { total: formatNumber(rows.length) })}
            </p>
            <div className="rounded-xl border border-border bg-surface shadow-sm">
              <Table data-testid="runs-table">
                <TableHeader>
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id}>
                      {group.headers.map((header) => (
                        <TableHead key={header.id} className="text-start">
                          {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      data-outcome={outcomeOf(row.original)}
                      data-selected={row.id === search.run ? 'true' : undefined}
                      className="data-[selected=true]:bg-surface-muted"
                    >
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id}>
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {runs.hasNextPage ? (
              <Button
                variant="secondary"
                className="self-start"
                busy={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                {t('runs.loadMore')}
              </Button>
            ) : null}
          </div>
        )}
      </QueryState>

      <Sheet
        open={Boolean(search.run)}
        onOpenChange={(next) => {
          if (!next) void closeRun();
        }}
      >
        <SheetContent
          side={dir === 'rtl' ? 'left' : 'right'}
          showCloseButton={false}
          className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
          data-testid="run-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus(runOpener.current);
          }}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border bg-bg px-4 py-3">
            <div className="flex flex-col">
              <SheetTitle className="text-lg">{t('runs.detail.title')}</SheetTitle>
              <SheetDescription className="text-xs">
                <bdi dir="ltr" className="font-mono">
                  {search.run}
                </bdi>
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('app.close')}>
                <XIcon aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
          <div className="p-4">
            {search.run ? <RunDetail runId={search.run} names={names} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
