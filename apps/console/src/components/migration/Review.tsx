import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { CheckCircle2Icon, ShieldCheckIcon, Undo2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../lib/format';
import { type MigrationJob, type MigrationReport, useMigrationProblems } from '../../lib/migration';
import { useTenant } from '../../lib/tenant';
import { ConfirmDialog } from '../AppDialog';
import { CheckboxField } from '../Fields';
import { ActionError, QueryState } from '../States';
import { Notice, useMigrationAction } from './MigrationParts';
import { reasonText } from './Preflight';
import { SampleReview } from './Sample';

const KINDS = ['conversation', 'message', 'note', 'contact', 'attachment'] as const;
const COLUMNS = [
  'discovered',
  'imported',
  'skipped',
  'quarantined',
  'failed',
  'pending',
  'rolledBack',
] as const;
const CHECKS = [
  'all_accounted',
  'export_complete',
  'no_duplicates',
  'private_kept_private',
  'nothing_sent',
  'sample_matches',
  'nothing_left',
] as const;

function CountsTable({ report }: { report: MigrationReport }) {
  const { t } = useTranslation();
  return (
    <Table data-testid="report-counts">
      <TableHeader>
        <TableRow>
          <TableHead className="text-start">{t('migration.review.columns.kind')}</TableHead>
          {COLUMNS.map((column) => (
            <TableHead key={column} className="text-end">
              {t(`migration.review.columns.${column}`)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {KINDS.map((kind) => (
          <TableRow key={kind} data-kind={kind}>
            <TableCell className="font-medium">{t(`migration.kinds.${kind}`)}</TableCell>
            {COLUMNS.map((column) => (
              <TableCell key={column} className="text-end tabular-nums" data-column={column}>
                {formatNumber(report.kinds[kind][column])}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Checks({ report }: { report: MigrationReport }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-2" data-testid="report-checks">
      {report.checks.map((check) => (
        <li
          key={check.code}
          data-check={check.code}
          data-ok={String(check.ok)}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
        >
          <span className="text-sm text-text">
            {(CHECKS as readonly string[]).includes(check.code)
              ? t(`migration.review.checks.codes.${check.code as (typeof CHECKS)[number]}`)
              : check.code}
            {check.detail ? (
              <span className="text-text-secondary">
                {' · '}
                <bdi dir="auto">{check.detail}</bdi>
              </span>
            ) : null}
          </span>
          <StatusBadge tone={check.ok ? 'success' : 'danger'}>
            {check.ok ? t('migration.review.checks.passed') : t('migration.review.checks.failed')}
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}

function Quarantine({ job }: { job: MigrationJob }) {
  const { t } = useTranslation();
  const problems = useMigrationProblems(job.id, job.updatedAt);
  const items = problems.data?.pages.flatMap((page) => page.items);
  return (
    <QueryState
      query={{
        data: items,
        error: problems.error,
        isPending: problems.isPending,
        isRefetching: problems.isRefetching,
        refetch: () => problems.refetch(),
      }}
      label={t('migration.review.quarantine.loading')}
      isEmpty={(rows) => rows.length === 0}
      empty={<p className="text-sm text-text-secondary">{t('migration.review.quarantine.none')}</p>}
    >
      {(rows) => (
        <div className="flex flex-col gap-2">
          <Table data-testid="report-quarantine">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">
                  {t('migration.review.quarantine.columns.kind')}
                </TableHead>
                <TableHead className="text-start">
                  {t('migration.review.quarantine.columns.id')}
                </TableHead>
                <TableHead className="text-start">
                  {t('migration.review.quarantine.columns.conversation')}
                </TableHead>
                <TableHead className="text-start">
                  {t('migration.review.quarantine.columns.reason')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => (
                <TableRow
                  key={`${item.kind}:${item.sourceId}`}
                  data-item={item.sourceId}
                  data-reason={item.reason ?? ''}
                >
                  <TableCell>{t(`migration.kind.${item.kind}`)}</TableCell>
                  <TableCell className="max-w-48 truncate">
                    <bdi dir="ltr" className="font-mono text-xs">
                      {item.sourceId}
                    </bdi>
                  </TableCell>
                  <TableCell className="max-w-48 truncate">
                    <bdi dir="ltr" className="font-mono text-xs">
                      {item.conversationSourceId ?? '—'}
                    </bdi>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {reasonText(t, item.reason) || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {problems.hasNextPage ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              busy={problems.isFetchingNextPage}
              onClick={() => problems.fetchNextPage()}
            >
              {t('migration.review.quarantine.more')}
            </Button>
          ) : null}
        </div>
      )}
    </QueryState>
  );
}

function Cutover({ job, report }: { job: MigrationJob; report: MigrationReport }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [removing, setRemoving] = useState(false);
  const failedChecks = report.gate === 'failed';

  return (
    <section
      aria-labelledby="cutover-title"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      data-testid="cutover"
    >
      <div className="flex flex-col gap-1">
        <h3 id="cutover-title" className="text-md font-semibold text-text">
          {t('migration.review.cutover.title')}
        </h3>
        <p className="text-sm text-text-secondary">{t('migration.review.cutover.description')}</p>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text">
        {(['counts', 'samples', 'live'] as const).map((item) => (
          <li key={item} className="flex items-start gap-2">
            <CheckCircle2Icon
              className="mt-0.5 size-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <span>{t(`migration.review.cutover.checklist.${item}`)}</span>
          </li>
        ))}
      </ul>
      {failedChecks ? (
        <div className="flex flex-col gap-1">
          <CheckboxField
            id="cutover-acknowledge"
            label={t('migration.review.cutover.acknowledge')}
            checked={acknowledged}
            onCheckedChange={(value) => {
              setAcknowledged(value);
              if (value) setError(undefined);
            }}
          />
          {error ? (
            <p id="cutover-acknowledge-error" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <ActionError error={act.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          busy={act.isPending && act.variables?.action === 'cutover'}
          data-testid="approve-cutover"
          onClick={async () => {
            if (failedChecks && !acknowledged) {
              setError(t('migration.review.cutover.acknowledgeRequired'));
              document.getElementById('cutover-acknowledge')?.focus();
              return;
            }
            try {
              await act.mutateAsync({
                action: 'cutover',
                body: { acknowledgeFailedChecks: failedChecks && acknowledged },
              });
              announce(t('migration.review.cutover.approved'));
            } catch {
              // Shown above.
            }
          }}
        >
          <ShieldCheckIcon aria-hidden="true" />
          {t('migration.review.cutover.approve')}
        </Button>
        <Button variant="destructive" onClick={() => setRemoving(true)} data-testid="rollback">
          <Undo2Icon className="rtl:-scale-x-100" aria-hidden="true" />
          {t('migration.review.rollback.action')}
        </Button>
      </div>
      <p className="text-xs text-text-secondary">{t('migration.review.cutover.rollbackWindow')}</p>
      <RollbackDialog job={job} open={removing} onOpenChange={setRemoving} />
    </section>
  );
}

function RollbackDialog({
  job,
  open,
  onOpenChange,
}: {
  job: MigrationJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const act = useMigrationAction(job.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('migration.review.rollback.title')}
      confirmLabel={t('migration.review.rollback.submit')}
      variant="destructive-solid"
      testId="rollback-dialog"
      onConfirm={async () => {
        await act.mutateAsync({ action: 'rollback' });
        announce(t('migration.review.rollback.started'));
      }}
    >
      <p>{t('migration.review.rollback.body')}</p>
    </ConfirmDialog>
  );
}

/** Step 4 once it has ended (HNV-18-06): every record accounted for, samples, cutover, rollback. */
export function Reconciliation({ job, report }: { job: MigrationJob; report: MigrationReport }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [removing, setRemoving] = useState(false);
  const missing = report.missingFromExport;

  if (report.kind === 'rollback') {
    const kept = report.checks.find((c) => c.code === 'nothing_left');
    return (
      <div className="flex flex-col gap-3" data-testid="rollback-report">
        <p className="text-sm text-text">
          {t('migration.review.rollback.done', {
            conversations: formatNumber(report.kinds.conversation.rolledBack),
            contacts: formatNumber(report.kinds.contact.rolledBack),
          })}
        </p>
        {kept && !kept.ok ? (
          <Notice tone="warning">
            <p>
              {t('migration.review.rollback.kept', {
                count: Number.parseInt(kept.detail ?? '0', 10) || 0,
              })}
            </p>
          </Notice>
        ) : null}
        <Checks report={report} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="reconciliation">
      <div className="flex flex-col gap-1">
        <h3 className="text-md font-semibold text-text">{t('migration.review.title')}</h3>
        <p className="text-sm text-text-secondary">{t('migration.review.description')}</p>
      </div>
      <CountsTable report={report} />
      {missing.messages !== undefined || missing.conversations !== undefined ? (
        <Notice tone="warning" testId="report-missing">
          <p>
            {t('migration.review.missingFromExport', {
              messages: formatNumber(missing.messages ?? 0),
              conversations: formatNumber(missing.conversations ?? 0),
            })}
          </p>
        </Notice>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-md font-semibold text-text">{t('migration.review.checks.title')}</h3>
        <Checks report={report} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-md font-semibold text-text">{t('migration.review.reasons.title')}</h3>
          {report.reasons.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('migration.review.reasons.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="report-reasons">
              {report.reasons.map((reason) => (
                <li
                  key={`${reason.kind}:${reason.reason}`}
                  className="flex items-center justify-between gap-3 border-b border-border py-1.5"
                  data-reason={reason.reason}
                >
                  <span className="text-text">
                    {t(`migration.kinds.${reason.kind as (typeof KINDS)[number]}`, {
                      defaultValue: reason.kind,
                    })}
                    {' · '}
                    {reasonText(t, reason.reason)}
                  </span>
                  <span className="tabular-nums text-text-secondary">
                    {formatNumber(reason.count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-md font-semibold text-text">
            {t('migration.review.unsupported.title')}
          </h3>
          {report.unsupportedFields.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('migration.review.unsupported.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="report-unsupported">
              {report.unsupportedFields.map((field) => (
                <li
                  key={field.path}
                  className="flex items-center justify-between gap-3 border-b border-border py-1.5"
                >
                  <bdi dir="ltr" className="font-mono text-xs text-text">
                    {field.path}
                  </bdi>
                  <span className="text-text-secondary">
                    {t('migration.review.unsupported.count', { count: field.count })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-md font-semibold text-text">
            {t('migration.review.quarantine.title')}
          </h3>
          <p className="text-sm text-text-secondary">
            {t('migration.review.quarantine.description')}
          </p>
        </div>
        <Quarantine job={job} />
      </div>

      {report.samples.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-md font-semibold text-text">
              {t('migration.review.samples.title')}
            </h3>
            <p className="text-sm text-text-secondary">
              {t('migration.review.samples.description')}
            </p>
          </div>
          <SampleReview job={job} samples={report.samples} compare />
        </div>
      ) : null}

      {can('migration.manage') && job.state === 'completed' ? (
        <Cutover job={job} report={report} />
      ) : null}
      {can('migration.manage') && (job.state === 'cancelled' || job.state === 'failed') ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            className="self-start"
            onClick={() => setRemoving(true)}
            data-testid="rollback"
          >
            <Undo2Icon className="rtl:-scale-x-100" aria-hidden="true" />
            {t('migration.review.rollback.action')}
          </Button>
          <RollbackDialog job={job} open={removing} onOpenChange={setRemoving} />
        </div>
      ) : null}
    </div>
  );
}
