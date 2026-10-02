import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ProgressStatus } from '@hamnivo/ui/components/progress-status';
import { DownloadIcon, PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../../lib/format';
import { downloadFile, type MigrationJob } from '../../lib/migration';
import { useTenant } from '../../lib/tenant';
import { ConfirmDialog } from '../AppDialog';
import { ActionError } from '../States';
import { Notice, Stat, useMigrationAction } from './MigrationParts';

const ERRORS = ['authority_unavailable', 'import_inbox_not_quiet', 'internal'] as const;

/** Step 4 while it runs (HNV-18-04): progress from the checkpoint, pause, resume and cancel. */
export function ImportProgress({ job }: { job: MigrationJob }) {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  const [cancelling, setCancelling] = useState(false);
  const conversations = job.progress.conversations;
  const total = job.progress.checkpoint.of || conversations.total;
  const done = job.progress.checkpoint.conversation;
  const imported = conversations.imported;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const runner = can('migration.run');

  const run = async (action: 'pause' | 'resume', message: string) => {
    try {
      await act.mutateAsync({ action });
      announce(message);
    } catch {
      // Shown below.
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="import-progress">
      <h3 className="text-md font-semibold text-text">{t('migration.progress.title')}</h3>
      <ProgressStatus
        label={
          job.state === 'queued'
            ? t('migration.progress.queued')
            : t('migration.progress.count', {
                done: formatNumber(imported),
                total: formatNumber(total),
              })
        }
        value={done}
        max={total}
        detail={
          job.progress.checkpoint.at
            ? `${t('migration.progress.percent', {
                percent: new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'percent' }).format(
                  percent / 100,
                ),
              })} · ${t('migration.progress.checkpoint', {
                done: formatNumber(done),
                total: formatNumber(total),
                time: formatDateTime(job.progress.checkpoint.at),
              })}`
            : undefined
        }
        data-testid="import-progressbar"
      />
      {job.requestedAction ? (
        <p role="status" className="text-sm text-text-secondary">
          {job.requestedAction === 'pause'
            ? t('migration.progress.pausing')
            : t('migration.progress.cancelling')}
        </p>
      ) : null}
      {job.state === 'paused' ? (
        <Notice tone="warning" testId="import-paused">
          <p>
            {t('migration.progress.paused', {
              done: formatNumber(done),
              total: formatNumber(total),
            })}
          </p>
        </Notice>
      ) : null}
      {job.state === 'failed' ? (
        <Notice tone="danger" testId="import-failed">
          <p>
            {t('migration.progress.failed', {
              reason: t(
                `migration.progress.errors.${
                  (ERRORS as readonly string[]).includes(job.error?.code ?? '')
                    ? (job.error?.code as (typeof ERRORS)[number])
                    : 'other'
                }`,
              ),
            })}
          </p>
        </Notice>
      ) : null}
      {job.state === 'running' || job.state === 'queued' ? (
        <Notice tone="info">
          <p>{t('migration.progress.closeHint')}</p>
        </Notice>
      ) : null}
      <ActionError error={act.error} />
      {runner ? (
        <div className="flex flex-wrap gap-2">
          {(job.state === 'running' || job.state === 'queued') && !job.requestedAction ? (
            <Button
              variant="secondary"
              busy={act.isPending && act.variables?.action === 'pause'}
              onClick={() => run('pause', t('migration.progress.pauseRequested'))}
            >
              <PauseIcon aria-hidden="true" />
              {t('migration.progress.pause')}
            </Button>
          ) : null}
          {job.state === 'paused' || job.state === 'failed' ? (
            <Button
              busy={act.isPending && act.variables?.action === 'resume'}
              onClick={() => run('resume', t('migration.progress.resumed'))}
            >
              <PlayIcon aria-hidden="true" />
              {t('migration.progress.resume')}
            </Button>
          ) : null}
          {job.requestedAction !== 'cancel' ? (
            <Button variant="destructive" onClick={() => setCancelling(true)}>
              {t('migration.progress.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('migration.progress.cancelTitle')}
        confirmLabel={t('migration.progress.cancel')}
        variant="destructive-solid"
        onConfirm={async () => {
          await act.mutateAsync({ action: 'cancel' });
          announce(t('migration.progress.cancelRequested'));
        }}
      >
        <p>{t('migration.progress.cancelBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

/** Step 4 when it has ended (HNV-18-05): what was imported, what was not, and a retry. */
export function ImportResult({ job }: { job: MigrationJob }) {
  const { t } = useTranslation();
  const { can, tenantId } = useTenant();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);
  const c = job.progress.conversations;
  const problems =
    Object.values(job.progress).reduce(
      (sum, value) => ('failed' in value ? sum + value.failed + value.quarantined : sum),
      0,
    ) > 0;
  const failed = Object.values(job.progress).reduce(
    (sum, value) => ('failed' in value ? sum + value.failed : sum),
    0,
  );
  const title =
    job.state === 'closed'
      ? t('migration.result.closed')
      : job.state === 'rolled_back' || job.state === 'rolling_back'
        ? t('migration.result.rolledBack')
        : job.state === 'cancelled'
          ? t('migration.result.cancelled')
          : problems || job.report?.gate === 'failed'
            ? t('migration.result.completedIssues')
            : t('migration.result.completed');

  return (
    <div className="flex flex-col gap-4" data-testid="import-result">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-md font-semibold text-text" data-testid="import-result-title">
          {title}
        </h3>
        {job.finishedAt ? (
          <p className="text-sm text-text-secondary">
            {job.state === 'closed' && job.closedAt
              ? t('migration.result.approved', { time: formatDateTime(job.closedAt) })
              : t('migration.result.finished', { time: formatDateTime(job.finishedAt) })}
          </p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-4" data-testid="import-result-counts">
        <Stat value={c.imported} label={t('migration.result.imported')} tone="success" />
        <Stat value={c.skipped} label={t('migration.result.skipped')} />
        <Stat
          value={c.quarantined + c.pending}
          label={t('migration.result.notImported')}
          tone={c.quarantined + c.pending > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          value={c.failed}
          label={t('migration.result.failed')}
          tone={c.failed > 0 ? 'danger' : 'neutral'}
        />
      </div>
      <ActionError error={act.error ?? downloadError} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          busy={downloading}
          onClick={async () => {
            setDownloading(true);
            setDownloadError(null);
            try {
              await downloadFile(
                `/v1/admin/migrations/${job.id}/rejections`,
                tenantId,
                `migration-${job.id}-not-imported.csv`,
              );
            } catch (caught) {
              setDownloadError(caught);
            } finally {
              setDownloading(false);
            }
          }}
          data-testid="download-rejections"
        >
          <DownloadIcon aria-hidden="true" />
          {t('migration.result.downloadErrors')}
        </Button>
        {can('migration.run') &&
        failed > 0 &&
        (job.state === 'completed' || job.state === 'failed') ? (
          <Button
            variant="secondary"
            busy={act.isPending}
            onClick={async () => {
              try {
                await act.mutateAsync({ action: 'retry' });
                announce(t('migration.result.retried'));
              } catch {
                // Shown above.
              }
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            {t('migration.result.retry')}
          </Button>
        ) : null}
      </div>
      {failed > 0 ? (
        <p className="text-sm text-text-secondary">{t('migration.result.retryHint')}</p>
      ) : null}
    </div>
  );
}
