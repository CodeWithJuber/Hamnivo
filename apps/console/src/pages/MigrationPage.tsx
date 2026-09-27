import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  DownloadIcon,
  FolderInputIcon,
  Loader2Icon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import { DryRunReview } from '../components/migration/DryRun';
import { ExportDialog, NewImportDialog } from '../components/migration/MigrationDialogs';
import {
  FileCard,
  MigrationStateBadge,
  Notice,
  Stepper,
  useMigrationAction,
} from '../components/migration/MigrationParts';
import { PreflightReport } from '../components/migration/Preflight';
import { ImportProgress, ImportResult } from '../components/migration/Progress';
import { Reconciliation } from '../components/migration/Review';
import { PageHeader } from '../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../components/States';
import { formatDateTime, formatNumber } from '../lib/format';
import {
  downloadFile,
  type MigrationJob,
  stepOf,
  useMigration,
  useMigrationSources,
  useMigrations,
} from '../lib/migration';
import { useNames } from '../lib/names';
import { useTenant } from '../lib/tenant';

const REJECTIONS = [
  'malware',
  'scan_unavailable',
  'not_supported',
  'truncated',
  'corrupt',
  'too_large',
  'too_many_files',
  'unsafe_path',
  'not_utf8',
  'empty',
] as const;

function JobList({ onOpen, onStart }: { onOpen: (id: string) => void; onStart?: () => void }) {
  const { t } = useTranslation();
  const names = useNames();
  const jobs = useMigrations();
  return (
    <section aria-labelledby="migrations-title" className="flex flex-col gap-3">
      <h2 id="migrations-title" tabIndex={-1} className="text-lg font-semibold text-text">
        {t('migration.list.title')}
      </h2>
      <QueryState
        query={jobs}
        label={t('migration.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('migration.list.empty.title')}
            description={t('migration.list.empty.description')}
            icon={<FolderInputIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={
              onStart ? (
                <Button onClick={onStart}>
                  <UploadIcon aria-hidden="true" />
                  {t('migration.newImport')}
                </Button>
              ) : (
                <span />
              )
            }
          />
        }
      >
        {(data) => (
          <div className="rounded-xl border border-border bg-surface p-2 shadow-sm">
            <Table data-testid="migrations-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('migration.list.columns.file')}</TableHead>
                  <TableHead className="text-start">{t('migration.list.columns.kind')}</TableHead>
                  <TableHead className="text-start">{t('migration.list.columns.brand')}</TableHead>
                  <TableHead className="text-start">{t('migration.list.columns.state')}</TableHead>
                  <TableHead className="text-start">
                    {t('migration.list.columns.conversations')}
                  </TableHead>
                  <TableHead className="text-start">
                    {t('migration.list.columns.started')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((job) => {
                  const total =
                    job.progress.conversations.total || (job.preflight?.counts.conversations ?? 0);
                  return (
                    <TableRow key={job.id} data-migration={job.label} data-state={job.state}>
                      <TableCell className="max-w-64 whitespace-normal">
                        <Button
                          variant="link"
                          className="h-auto p-0 text-start whitespace-normal"
                          onClick={() => onOpen(job.id)}
                          aria-label={t('migration.list.open', { name: job.label })}
                        >
                          <bdi>{job.label}</bdi>
                        </Button>
                      </TableCell>
                      <TableCell>
                        {job.kind === 'export'
                          ? t('migration.list.exportKind')
                          : t('migration.list.importKind', {
                              source: t(`migration.sources.${job.source}`),
                            })}
                      </TableCell>
                      <TableCell>
                        <bdi>{names.brand(job.brandId) ?? '—'}</bdi>
                      </TableCell>
                      <TableCell>
                        <MigrationStateBadge state={job.state} />
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {job.kind === 'export'
                          ? '—'
                          : job.progress.conversations.total > 0
                            ? t('migration.list.of', {
                                done: formatNumber(job.progress.conversations.imported),
                                total: formatNumber(total),
                              })
                            : formatNumber(total || null)}
                      </TableCell>
                      <TableCell>{formatDateTime(job.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** An export job: preparing, then a package to download for 24 hours. */
function ExportView({ job }: { job: MigrationJob }) {
  const { t } = useTranslation();
  const { tenantId, can } = useTenant();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (job.state === 'queued' || job.state === 'running') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
        <Loader2Icon
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t('migration.export.running')}
      </p>
    );
  }
  if (job.state === 'failed') {
    return <Notice tone="danger">{t('migration.export.failed')}</Notice>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="export-ready">
      <h3 className="text-md font-semibold text-text">{t('migration.export.ready')}</h3>
      {job.packageAvailable && can('conversations.export') ? (
        <Button
          className="self-start"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await downloadFile(
                `/v1/admin/migrations/${job.id}/package`,
                tenantId,
                `hamnivo-export-${job.id}.zip`,
              );
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
          data-testid="download-package"
        >
          <DownloadIcon aria-hidden="true" />
          {t('migration.export.download')}
        </Button>
      ) : (
        <p className="text-sm text-text-secondary">{t('migration.export.expired')}</p>
      )}
      <ActionError error={error} />
    </div>
  );
}

/** Step 2 actions: check again, review a sample (a dry run), or cancel. */
function CheckActions({ job }: { job: MigrationJob }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  const [cancelling, setCancelling] = useState(false);
  if (!can('migration.run')) return null;
  const blocking = job.state === 'blocked' || job.preflight?.blocking;
  return (
    <div className="flex flex-col gap-3">
      {blocking ? (
        <Notice tone="warning" testId="preflight-blocking">
          <p>{t('migration.preflight.blocking')}</p>
        </Notice>
      ) : null}
      <ActionError error={act.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => setCancelling(true)}>
          {t('migration.preflight.cancel')}
        </Button>
        <Button
          variant="secondary"
          busy={act.isPending && act.variables?.action === 'preflight'}
          onClick={() => act.mutate({ action: 'preflight' })}
        >
          <RefreshCwIcon aria-hidden="true" />
          {t('migration.preflight.recheck')}
        </Button>
        <Button
          disabled={Boolean(blocking)}
          busy={act.isPending && act.variables?.action === 'dry-run'}
          onClick={() => act.mutate({ action: 'dry-run' })}
          data-testid="start-dry-run"
        >
          {t('migration.preflight.next')}
        </Button>
      </div>
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('migration.preflight.cancelTitle')}
        confirmLabel={t('migration.preflight.cancel')}
        variant="destructive-solid"
        onConfirm={async () => {
          await act.mutateAsync({ action: 'cancel' });
          announce(t('migration.preflight.cancelled'));
        }}
      >
        <p>{t('migration.preflight.cancelBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

function StepContent({ job, onNewImport }: { job: MigrationJob; onNewImport?: () => void }) {
  const { t } = useTranslation();
  const names = useNames();
  const sources = useMigrationSources();
  const source = sources.data?.items.find((s) => s.system === job.source);
  const brandName = names.brand(job.brandId) ?? '';

  switch (job.state) {
    case 'scanning':
      return (
        <div role="status" className="flex items-start gap-3" data-testid="scanning">
          <Loader2Icon
            className="mt-0.5 size-5 animate-spin text-info motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-0.5">
            <p className="font-medium text-text">{t('migration.scanning.title')}</p>
            <p className="text-sm text-text-secondary">{t('migration.scanning.description')}</p>
          </div>
        </div>
      );
    case 'rejected': {
      const code = job.error?.code ?? 'other';
      return (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title={t('migration.rejected.title')} testId="rejected">
            <p>
              {t(
                `migration.rejected.reasons.${
                  (REJECTIONS as readonly string[]).includes(code)
                    ? (code as (typeof REJECTIONS)[number])
                    : 'other'
                }`,
              )}
            </p>
          </Notice>
          {onNewImport ? (
            <Button variant="secondary" className="self-start" onClick={onNewImport}>
              <UploadIcon aria-hidden="true" />
              {t('migration.file.change')}
            </Button>
          ) : null}
        </div>
      );
    }
    case 'blocked':
    case 'ready':
      return job.preflight ? (
        <div className="flex flex-col gap-6">
          <PreflightReport preflight={job.preflight} source={source} />
          <CheckActions job={job} />
        </div>
      ) : null;
    case 'dry_running':
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2Icon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t('migration.dryRun.counting')}
        </p>
      );
    case 'dry_run_ready':
      return job.dryRun ? (
        <DryRunReview job={job} dryRun={job.dryRun} brandName={brandName} />
      ) : null;
    case 'queued':
    case 'running':
    case 'paused':
      return <ImportProgress job={job} />;
    case 'failed':
      return (
        <div className="flex flex-col gap-6">
          <ImportProgress job={job} />
          {job.report ? <Reconciliation job={job} report={job.report} /> : null}
        </div>
      );
    default:
      if (job.state === 'cancelled' && !job.startedAt) {
        return <Notice tone="info">{t('migration.result.cancelled')}</Notice>;
      }
      return (
        <div className="flex flex-col gap-6">
          <ImportResult job={job} />
          {job.report ? <Reconciliation job={job} report={job.report} /> : null}
        </div>
      );
  }
}

function JobView({
  id,
  onBack,
  onNewImport,
}: {
  id: string;
  onBack: () => void;
  onNewImport?: () => void;
}) {
  const { t } = useTranslation();
  const names = useNames();
  const job = useMigration(id);
  const state = job.data?.state;
  const announce = useAnnouncer();
  // Say when the worker moves the job on, for people who can't see the page change.
  useEffect(() => {
    if (state) announce(t(`migration.state.${state}`));
  }, [state, announce, t]);

  return (
    <div className="flex flex-col gap-4">
      <Button variant="link" className="h-auto self-start p-0 has-[>svg]:px-0" onClick={onBack}>
        <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
        {t('migration.back')}
      </Button>
      <QueryState query={job} label={t('migration.loading')}>
        {(data) => (
          <section
            aria-labelledby="migration-title"
            data-testid="migration-job"
            data-state={data.state}
            className="flex min-w-0 flex-col gap-6 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="migration-title" tabIndex={-1} className="text-lg font-semibold text-text">
                <bdi>{data.label}</bdi>
              </h2>
              <MigrationStateBadge state={data.state} />
            </div>
            {data.kind === 'export' ? (
              <ExportView job={data} />
            ) : (
              <>
                <Stepper step={stepOf(data)} />
                <FileCard
                  job={data}
                  brandName={names.brand(data.brandId)}
                  action={
                    onNewImport && ['rejected', 'blocked', 'ready'].includes(data.state) ? (
                      <Button variant="secondary" size="sm" onClick={onNewImport}>
                        {t('migration.file.change')}
                      </Button>
                    ) : undefined
                  }
                />
                <StepContent job={data} {...(onNewImport ? { onNewImport } : {})} />
              </>
            )}
          </section>
        )}
      </QueryState>
    </div>
  );
}

/** Imports and exports (board 18: HNV-18-01 to HNV-18-06). */
export function MigrationPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/migration' });
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const open = (id: string | undefined) =>
    navigate({ to: '/migration', search: id ? { job: id } : {} });
  const startImport = can('migration.run') ? () => setUploading(true) : undefined;

  const actions = (
    <>
      {can('conversations.export') ? (
        <Button variant="secondary" onClick={() => setExporting(true)}>
          <DownloadIcon aria-hidden="true" />
          {t('migration.exportHistory')}
        </Button>
      ) : null}
      {startImport ? (
        <Button onClick={startImport} data-testid="new-import">
          <UploadIcon aria-hidden="true" />
          {t('migration.newImport')}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('migration.title')}
        description={t('migration.description')}
        actions={actions}
      />
      {!can('migration.review') ? (
        <Forbidden compact />
      ) : search.job ? (
        <JobView
          id={search.job}
          onBack={() => {
            void open(undefined).then(() => document.getElementById('migrations-title')?.focus());
          }}
          {...(startImport ? { onNewImport: startImport } : {})}
        />
      ) : (
        <JobList
          onOpen={(id) => void open(id)}
          {...(startImport ? { onStart: startImport } : {})}
        />
      )}
      <NewImportDialog
        open={uploading}
        onOpenChange={setUploading}
        onCreated={(job) => void open(job.id)}
      />
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        onCreated={(job) => void open(job.id)}
      />
    </div>
  );
}
