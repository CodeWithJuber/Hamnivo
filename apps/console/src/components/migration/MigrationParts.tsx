import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { cn } from '@hamnivo/ui/lib/utils';
import {
  CheckIcon,
  ClockIcon,
  FileArchiveIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/format';
import type { MigrationJob, MigrationState } from '../../lib/migration';
import { migrationKeys } from '../../lib/migration';
import { useStudioMutation } from '../../lib/queries';

const stateTone: Record<MigrationState, StatusTone> = {
  scanning: 'info',
  rejected: 'danger',
  blocked: 'warning',
  ready: 'info',
  dry_running: 'info',
  dry_run_ready: 'brand',
  queued: 'neutral',
  running: 'info',
  paused: 'warning',
  cancelled: 'neutral',
  completed: 'success',
  failed: 'danger',
  rolling_back: 'info',
  rolled_back: 'neutral',
  closed: 'success',
};

const WORKING: ReadonlySet<MigrationState> = new Set([
  'scanning',
  'dry_running',
  'running',
  'rolling_back',
]);

export function MigrationStateBadge({ state }: { state: MigrationState }) {
  const { t } = useTranslation();
  const icon = WORKING.has(state) ? (
    <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
  ) : state === 'queued' ? (
    <ClockIcon className="size-3.5" aria-hidden="true" />
  ) : undefined;
  return (
    <StatusBadge tone={stateTone[state]} icon={icon} data-state={state}>
      {t(`migration.state.${state}`)}
    </StatusBadge>
  );
}

export function CheckBadge({ status }: { status: 'ok' | 'warning' | 'blocked' }) {
  const { t } = useTranslation();
  const tone: Record<typeof status, StatusTone> = {
    ok: 'success',
    warning: 'warning',
    blocked: 'danger',
  };
  return (
    <StatusBadge tone={tone[status]} data-check={status}>
      {t(`migration.preflight.checks.status.${status}`)}
    </StatusBadge>
  );
}

/** A note in the flow of the page: information, a warning or a problem (never colour alone). */
export function Notice({
  tone = 'info',
  title,
  children,
  testId,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const Icon = tone === 'info' ? InfoIcon : TriangleAlertIcon;
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-sm text-text',
        tone === 'info' && 'border-info/30 bg-info-subtle',
        tone === 'warning' && 'border-warning/40 bg-warning-subtle',
        tone === 'danger' && 'border-danger/30 bg-danger-subtle',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'info' && 'text-info',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** A large count with what it stands for (the board's "240 conversations ready"). */
export function Stat({
  value,
  label,
  hint,
  tone = 'neutral',
  testId,
}: {
  value: number;
  label: string;
  hint?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'neutral' && 'text-text',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
      >
        {formatNumber(value)}
      </span>
      <span className="text-sm font-medium text-text">{label}</span>
      {hint ? <span className="text-xs text-text-secondary">{hint}</span> : null}
    </div>
  );
}

/** The four steps of an import; the current one is marked for screen readers too. */
export function Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  const { t } = useTranslation();
  const steps = [
    { label: t('migration.steps.source'), hint: t('migration.steps.sourceHint') },
    { label: t('migration.steps.check'), hint: t('migration.steps.checkHint') },
    { label: t('migration.steps.sample'), hint: t('migration.steps.sampleHint') },
    { label: t('migration.steps.import'), hint: t('migration.steps.importHint') },
  ];
  return (
    <ol
      aria-label={t('migration.steps.label')}
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
      data-testid="migration-steps"
    >
      {steps.map((item, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <li
            key={item.label}
            aria-current={current ? 'step' : undefined}
            data-step={number}
            className="flex min-w-0 items-center gap-3"
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
                current && 'border-brand-strong bg-brand-strong text-on-brand-strong',
                done && 'border-success bg-success-subtle text-success',
                !current && !done && 'border-border text-text-secondary',
              )}
            >
              {done ? <CheckIcon className="size-4" aria-hidden="true" /> : formatNumber(number)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-text">
                {item.label}
                {done ? <span className="sr-only"> ({t('migration.steps.done')})</span> : null}
                {current ? (
                  <span className="sr-only"> ({t('migration.steps.current')})</span>
                ) : null}
              </span>
              <span className="text-xs text-text-secondary">{item.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The uploaded file: name, when, how large, and into which brand. */
export function FileCard({
  job,
  brandName,
  action,
}: {
  job: MigrationJob;
  brandName: string | undefined;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const purged =
    job.file !== null && !job.exportAvailable && !['rejected', 'scanning'].includes(job.state);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
      data-testid="migration-file"
    >
      <div className="flex min-w-0 items-center gap-3">
        <FileArchiveIcon className="size-6 shrink-0 text-text-muted" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-text">
            <bdi>{job.file?.name ?? job.label}</bdi>
          </span>
          {job.file ? (
            <span className="text-xs text-text-secondary">
              {t('migration.file.uploaded', {
                time: formatDateTime(job.file.uploadedAt),
                size: formatBytes(job.file.byteSize),
              })}
              {brandName ? (
                <>
                  {' · '}
                  <bdi>{t('migration.file.into', { brand: brandName })}</bdi>
                </>
              ) : null}
            </span>
          ) : null}
          {purged ? (
            <span className="text-xs text-text-secondary">{t('migration.file.purged')}</span>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  );
}

/** Actions on one import; every change reloads the imports and asks for a fresh sign-in when needed. */
export function useMigrationAction(id: string) {
  return useStudioMutation(
    ({ action, body }: { action: string; body?: unknown }, tenant) =>
      api<MigrationJob>(`/v1/admin/migrations/${id}/${action}`, {
        method: 'POST',
        body: body ?? {},
        tenant,
      }),
    [migrationKeys.all],
  );
}
