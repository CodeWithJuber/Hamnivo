import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { DownloadIcon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../lib/format';
import { type MigrationDryRun, type MigrationJob, saveBlob } from '../../lib/migration';
import { useTenant } from '../../lib/tenant';
import { ConfirmDialog } from '../AppDialog';
import { SelectField } from '../Fields';
import { ActionError } from '../States';
import { Notice, Stat, useMigrationAction } from './MigrationParts';
import { SampleReview } from './Sample';

/** The review report: counts, fields, checks and issues of the dry run, never message text. */
function downloadReviewReport(job: MigrationJob) {
  const report = {
    migration: job.id,
    file: job.file,
    source: job.source,
    preflight: job.preflight,
    dryRun: job.dryRun,
  };
  saveBlob(
    new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }),
    `migration-${job.id}-review.json`,
  );
}

/** Step 3 (HNV-18-03): what the import would do, a redacted sample, then the import itself. */
export function DryRunReview({
  job,
  dryRun,
  brandName,
}: {
  job: MigrationJob;
  dryRun: MigrationDryRun;
  brandName: string;
}) {
  const { t } = useTranslation();
  const { can, tenant } = useTenant();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  const [confirming, setConfirming] = useState(false);
  const runnable = can('migration.run') && job.state === 'dry_run_ready';

  return (
    <div className="flex flex-col gap-6" data-testid="dry-run">
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-text">{t('migration.dryRun.title')}</h3>
        <p className="text-sm text-text-secondary">{t('migration.dryRun.description')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3" data-testid="dry-run-counts">
        <Stat
          value={dryRun.conversations.ready}
          label={t('migration.dryRun.ready')}
          hint={t('migration.dryRun.readyHint')}
          tone="success"
          testId="dry-run-ready"
        />
        <Stat
          value={dryRun.conversations.duplicates}
          label={t('migration.dryRun.duplicates')}
          hint={t('migration.dryRun.duplicatesHint')}
          tone={dryRun.conversations.duplicates > 0 ? 'warning' : 'neutral'}
          testId="dry-run-duplicates"
        />
        <Stat
          value={dryRun.conversations.needsReview}
          label={t('migration.dryRun.review')}
          hint={t('migration.dryRun.reviewHint')}
          tone={dryRun.conversations.needsReview > 0 ? 'danger' : 'neutral'}
          testId="dry-run-review"
        />
      </div>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-text">
        <li>
          {t('migration.dryRun.messages', {
            ready: formatNumber(dryRun.messages.ready),
            internal: formatNumber(dryRun.messages.internal),
          })}
        </li>
        <li>
          {t('migration.dryRun.people', {
            verified: formatNumber(dryRun.identity.verified),
            unverified: formatNumber(dryRun.identity.unverified),
          })}
          <span className="block text-text-secondary">{t('migration.dryRun.peopleHint')}</span>
        </li>
        <li>
          {t('migration.dryRun.files', {
            ready: formatNumber(dryRun.attachments.ready),
            review: formatNumber(dryRun.attachments.needsReview),
          })}
        </li>
      </ul>
      {dryRun.truncated ? (
        <Notice tone="warning" testId="dry-run-truncated">
          <p>{t('migration.dryRun.truncated')}</p>
        </Notice>
      ) : null}
      <div className="sm:max-w-72">
        <SelectField
          id="dry-run-duplicates-choice"
          label={t('migration.dryRun.duplicateChoice')}
          hint={t('migration.dryRun.duplicateHint')}
          value="skip"
          onChange={() => undefined}
          options={[{ value: 'skip', label: t('migration.dryRun.duplicateSkip') }]}
        />
      </div>

      {dryRun.samples.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-md font-semibold text-text">{t('migration.sample.title')}</h3>
            <p className="text-sm text-text-secondary">{t('migration.sample.description')}</p>
          </div>
          <SampleReview job={job} samples={dryRun.samples} compare={false} />
        </div>
      ) : null}

      <Notice tone="info">
        <p>
          {t('migration.dryRun.destination', { brand: brandName })}{' '}
          {t('migration.dryRun.nothingSent')}
        </p>
      </Notice>
      <ActionError error={act.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => downloadReviewReport(job)}>
          <DownloadIcon aria-hidden="true" />
          {t('migration.dryRun.report')}
        </Button>
        {runnable ? (
          <>
            <Button
              variant="secondary"
              busy={act.isPending && act.variables?.action === 'dry-run'}
              onClick={() => act.mutate({ action: 'dry-run' })}
            >
              {t('migration.dryRun.again')}
            </Button>
            <Button
              onClick={() => setConfirming(true)}
              disabled={dryRun.conversations.ready === 0}
              data-testid="run-import"
            >
              <PlayIcon aria-hidden="true" />
              {t('migration.dryRun.run')}
            </Button>
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('migration.dryRun.runTitle', {
          count: dryRun.conversations.ready,
          brand: brandName || tenant.name,
        })}
        confirmLabel={t('migration.dryRun.runSubmit')}
        testId="run-import-dialog"
        onConfirm={async () => {
          await act.mutateAsync({ action: 'start', body: { duplicates: 'skip' } });
          announce(t('migration.dryRun.started'));
        }}
      >
        <p>{t('migration.dryRun.runBody')}</p>
        <p>{t('migration.dryRun.nothingSent')}</p>
      </ConfirmDialog>
    </div>
  );
}
