import { EmptyState } from '@hamnivo/ui/components/async-states';
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
import { useQueryClient } from '@tanstack/react-query';
import { ClockIcon, ExternalLinkIcon, GlobeIcon, Loader2Icon, SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  aiPowerKeys,
  type KnowledgeWebPage,
  type KnowledgeWebSource,
  useWebPages,
  type WebSyncSummary,
} from '../../lib/ai-power';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { keys, useStudioMutation } from '../../lib/queries';
import { useTenant } from '../../lib/tenant';
import { ActionError, QueryState } from '../States';

type Shown = 'queued' | 'running' | NonNullable<KnowledgeWebSource['lastResult']> | 'never';

/** What a person is told about a website: its read in progress, or how the last read went. */
function shownState(web: KnowledgeWebSource): Shown {
  return web.state === 'idle' ? (web.lastResult ?? 'never') : web.state;
}

const stateTone: Record<Shown, StatusTone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  partial: 'warning',
  failed: 'danger',
  never: 'neutral',
};

export function WebStateBadge({ web }: { web: KnowledgeWebSource }) {
  const { t } = useTranslation();
  const state = shownState(web);
  const icon =
    state === 'queued' ? (
      <ClockIcon className="size-3.5" aria-hidden="true" />
    ) : state === 'running' ? (
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
    ) : undefined;
  return (
    <StatusBadge tone={stateTone[state]} icon={icon} data-state={state}>
      {t(`aiPower.web.panel.state.${state}`)}
    </StatusBadge>
  );
}

/** One line under a source in the list: that it is a website, and how its reading stands. */
export function WebSourceLine({ web }: { web: KnowledgeWebSource }) {
  const { t } = useTranslation();
  const text =
    web.state === 'running'
      ? t('aiPower.web.line.reading')
      : web.state === 'queued'
        ? t('aiPower.web.line.waiting')
        : web.lastRunAt
          ? t('aiPower.web.line.last', { time: formatRelative(web.lastRunAt) })
          : t('aiPower.web.line.never');
  return (
    <p className="flex items-center gap-1 text-xs text-text-secondary" data-testid="web-line">
      <GlobeIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {t('aiPower.web.badge')} · {text}
      </span>
    </p>
  );
}

const SKIP_ORDER = ['robots', 'offsite', 'noindex', 'type', 'duplicate', 'empty'] as const;

/** What the last read did, in counts and the first few reasons. Reasons come from Hamnivo. */
function LastRead({ run }: { run: WebSyncSummary }) {
  const { t } = useTranslation();
  const skipped = SKIP_ORDER.filter((reason) => run.skipped[reason] > 0);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="web-last-run">
      <h4 className="text-xs font-semibold text-text-secondary">
        {t('aiPower.web.panel.summary.title')}
      </h4>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li>{t('aiPower.web.panel.summary.added', { total: formatNumber(run.added) })}</li>
        <li>{t('aiPower.web.panel.summary.updated', { total: formatNumber(run.updated) })}</li>
        <li>{t('aiPower.web.panel.summary.unchanged', { total: formatNumber(run.unchanged) })}</li>
        <li>{t('aiPower.web.panel.summary.retired', { total: formatNumber(run.retired) })}</li>
        <li>{t('aiPower.web.panel.summary.sitemaps', { total: formatNumber(run.sitemaps) })}</li>
      </ul>
      {skipped.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-text-secondary">
            {t('aiPower.web.panel.summary.leftOut')}
          </p>
          <ul className="flex flex-col gap-0.5 text-sm">
            {skipped.map((reason) => (
              <li key={reason}>
                {t(`aiPower.web.panel.summary.skipped.${reason}`, {
                  total: formatNumber(run.skipped[reason]),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.problems.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="web-problems">
          <p className="text-xs font-semibold text-danger">
            {t('aiPower.web.panel.summary.problems')}
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {run.problems.map((problem) => (
              <li key={`${problem.url}-${problem.reason}`} className="min-w-0">
                <bdi dir="ltr" className="break-all font-mono text-xs">
                  {problem.url}
                </bdi>
                <span className="text-text-secondary"> — </span>
                <bdi dir="auto">{problem.reason}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.truncated ? (
        <p className="text-sm text-text-secondary">{t('aiPower.web.panel.summary.truncated')}</p>
      ) : null}
      <p className="text-sm text-text-secondary">
        {t(`aiPower.web.panel.summary.robots.${run.robots}`)}
      </p>
    </div>
  );
}

const pageTone: Record<KnowledgeWebPage['state'], StatusTone> = {
  ok: 'success',
  failed: 'danger',
  gone: 'neutral',
};

/** Every page of the website and what the last read made of it. */
function WebPages({ web }: { web: KnowledgeWebSource }) {
  const { t } = useTranslation();
  const pages = useWebPages(web.id, true);
  return (
    <div className="flex flex-col gap-2" data-testid="web-pages">
      <h4 className="text-xs font-semibold text-text-secondary">
        {t('aiPower.web.panel.pagesList.title')}
      </h4>
      <QueryState
        query={pages}
        label={t('aiPower.web.panel.pagesList.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('aiPower.web.panel.pagesList.empty')}
            description=""
            action={<span />}
          />
        }
      >
        {(data) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">
                  {t('aiPower.web.panel.pagesList.columns.address')}
                </TableHead>
                <TableHead className="text-start">
                  {t('aiPower.web.panel.pagesList.columns.state')}
                </TableHead>
                <TableHead className="text-start">
                  {t('aiPower.web.panel.pagesList.columns.note')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((page) => (
                <TableRow key={page.url} data-page-state={page.state}>
                  <TableCell className="max-w-72 whitespace-normal">
                    <bdi dir="ltr" className="break-all font-mono text-xs">
                      {page.url}
                    </bdi>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={pageTone[page.state]}>
                      {t(`aiPower.web.panel.pagesList.states.${page.state}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm text-text-secondary">
                    {page.error ? <bdi dir="auto">{page.error}</bdi> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}

/**
 * The website behind a knowledge source (G04): where it starts, how far it reads and how often,
 * how its last read went, and a button to read it now. Its pages are the source's documents.
 */
export function WebSourcePanel({
  web,
  onSettings,
}: {
  web: KnowledgeWebSource;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const { can, tenantId } = useTenant();
  const announce = useAnnouncer();
  const client = useQueryClient();
  const [showPages, setShowPages] = useState(false);
  const reading = web.state !== 'idle';
  const manage = can('knowledge.manage') && web.status !== 'retired';

  // When a read ends, what it found is in the documents and the page list: load them again.
  const before = useRef(web.state);
  useEffect(() => {
    if (before.current !== 'idle' && web.state === 'idle') {
      void client.invalidateQueries({ queryKey: [tenantId, ...keys.sources] });
      void client.invalidateQueries({ queryKey: [tenantId, ...aiPowerKeys.webPages(web.id)] });
    }
    before.current = web.state;
  }, [web.state, web.id, tenantId, client]);

  const sync = useStudioMutation(
    (_: undefined, tenant) =>
      api<KnowledgeWebSource>(`/v1/admin/knowledge/web-sources/${web.id}/sync`, {
        method: 'POST',
        tenant,
      }),
    [aiPowerKeys.webSources],
  );

  return (
    <section
      aria-labelledby={`web-${web.id}`}
      data-testid="web-panel"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={`web-${web.id}`}
          className="flex items-center gap-2 text-sm font-semibold text-text"
        >
          <GlobeIcon className="size-4" aria-hidden="true" />
          {t('aiPower.web.panel.title')}
        </h3>
        <WebStateBadge web={web} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-text-secondary">{t('aiPower.web.panel.address')}</dt>
        <dd className="min-w-0">
          <a
            href={web.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1 text-link underline underline-offset-4 hover:no-underline"
          >
            <bdi dir="ltr" className="break-all">
              {web.url}
            </bdi>
            <ExternalLinkIcon className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
          </a>
        </dd>
        <dt className="text-text-secondary">{t('aiPower.web.panel.reads')}</dt>
        <dd>
          {web.mode === 'site'
            ? t('aiPower.web.panel.readsSite', {
                pages: formatNumber(web.maxPages),
                depth: formatNumber(web.maxDepth),
              })
            : t('aiPower.web.panel.readsPage')}
        </dd>
        <dt className="text-text-secondary">{t('aiPower.web.panel.schedule')}</dt>
        <dd>
          {t(`aiPower.web.schedule.${web.schedule}`)}
          {web.nextRunAt
            ? ` · ${t('aiPower.web.panel.next', { time: formatDateTime(web.nextRunAt) })}`
            : ''}
        </dd>
        <dt className="text-text-secondary">{t('aiPower.web.panel.pages')}</dt>
        <dd>{formatNumber(web.pageCount)}</dd>
        <dt className="text-text-secondary">{t('aiPower.web.panel.lastRead')}</dt>
        <dd>
          {web.lastRunAt
            ? `${formatDateTime(web.lastRunAt)} (${formatRelative(web.lastRunAt)})`
            : t('aiPower.web.panel.never')}
        </dd>
      </dl>
      {reading ? (
        <p className="text-xs text-text-secondary" role="status">
          {t('aiPower.web.panel.polling')}
        </p>
      ) : null}
      {web.lastRun ? <LastRead run={web.lastRun} /> : null}
      <ActionError error={sync.error} />
      <div className="flex flex-wrap gap-2">
        {manage ? (
          <>
            <Button
              size="sm"
              busy={reading || sync.isPending}
              disabled={reading}
              aria-label={t('aiPower.web.panel.actions.syncLabel', { name: web.name })}
              onClick={async () => {
                try {
                  await sync.mutateAsync(undefined);
                  announce(t('aiPower.web.panel.actions.queued', { name: web.name }));
                } catch {
                  // Shown above the actions.
                }
              }}
            >
              {t('aiPower.web.panel.actions.sync')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onSettings}
              aria-label={t('aiPower.web.panel.actions.settingsLabel', { name: web.name })}
            >
              <SettingsIcon aria-hidden="true" />
              {t('aiPower.web.panel.actions.settings')}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showPages}
          onClick={() => setShowPages((shown) => !shown)}
        >
          {showPages
            ? t('aiPower.web.panel.actions.hidePages')
            : t('aiPower.web.panel.actions.showPages')}
        </Button>
      </div>
      {showPages ? <WebPages web={web} /> : null}
    </section>
  );
}
