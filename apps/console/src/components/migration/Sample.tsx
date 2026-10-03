import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { cn } from '@hamnivo/ui/lib/utils';
import { LockIcon, PaperclipIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import { type MigrationJob, type MigrationSample, useMigrationSample } from '../../lib/migration';
import { SelectField } from '../Fields';
import { QueryState } from '../States';
import { reasonText } from './Preflight';

type Side = NonNullable<MigrationSample['imported']>;

function Conversation({ side, label, testId }: { side: Side; label: string; testId: string }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={label}
      data-testid={testId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-semibold text-text">{label}</h4>
        <p className="text-xs text-text-secondary">
          {side.contactName ? (
            <>
              <bdi>{side.contactName}</bdi>
              {' · '}
            </>
          ) : null}
          {side.startedAt
            ? t('migration.sample.started', { time: formatDateTime(side.startedAt) })
            : null}
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {side.messages.map((message, index) => {
          const internal = message.visibility === 'internal';
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a message may have no source ID; order is the key
              key={`${message.sourceId ?? 'm'}-${index}`}
              data-message={message.sourceId ?? ''}
              data-visibility={message.visibility}
              className={cn(
                'flex flex-col gap-1 rounded-lg border p-3',
                internal
                  ? 'border-dashed border-lane-internal-border bg-lane-internal'
                  : message.author.kind === 'customer'
                    ? 'border-border bg-surface-muted'
                    : 'border-border bg-surface',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
                <span className="font-medium text-text">
                  {message.author.name ? (
                    <bdi>{message.author.name}</bdi>
                  ) : (
                    t(`migration.sample.authors.${message.author.kind}`)
                  )}
                </span>
                {message.author.name ? (
                  <span>{t(`migration.sample.authors.${message.author.kind}`)}</span>
                ) : null}
                {message.createdAt ? (
                  <span>
                    {t('migration.sample.originalTime', {
                      time: formatDateTime(message.createdAt),
                    })}
                  </span>
                ) : null}
                {message.importedAt ? (
                  <span>
                    {t('migration.sample.importedAt', {
                      time: formatDateTime(message.importedAt),
                    })}
                  </span>
                ) : null}
                {internal ? (
                  <StatusBadge
                    tone="neutral"
                    icon={<LockIcon className="size-3.5" aria-hidden="true" />}
                  >
                    {t('migration.sample.internal')}
                  </StatusBadge>
                ) : null}
              </div>
              <p className="text-sm whitespace-pre-line text-text" dir="auto">
                {message.text ?? (
                  <span className="text-text-muted">{t('migration.sample.noText')}</span>
                )}
              </p>
              {message.attachments.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {message.attachments.map((file, fileIndex) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: files of one message, in order
                      key={fileIndex}
                      className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
                    >
                      <PaperclipIcon className="size-3.5" aria-hidden="true" />
                      <bdi className="text-text">{file.name}</bdi>
                      {file.status !== 'imported' && file.status !== 'pending' ? (
                        <StatusBadge tone={file.status === 'skipped' ? 'neutral' : 'warning'}>
                          {file.status === 'rolled_back'
                            ? t('migration.state.rolled_back')
                            : reasonText(t, file.reason) || reasonText(t, 'invalid_record')}
                        </StatusBadge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * One conversation from the export (redacted), and when it was imported, what Chatwoot now holds
 * beside it (HNV-18-03 sample, HNV-18-06 sample review).
 */
export function SampleReview({
  job,
  samples,
  compare,
}: {
  job: MigrationJob;
  samples: string[];
  compare: boolean;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | undefined>(samples[0]);
  const conversationId = chosen && samples.includes(chosen) ? chosen : samples[0];
  const sample = useMigrationSample(job.id, conversationId, job.updatedAt);
  if (samples.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="sample">
      {samples.length > 1 ? (
        <div className="sm:max-w-72">
          <SelectField
            id="sample-choice"
            label={t('migration.sample.choose')}
            value={conversationId ?? ''}
            onChange={(event) => setChosen(event.target.value)}
            options={samples.map((id, index) => ({
              value: id,
              label: t('migration.sample.option', { number: index + 1 }),
            }))}
          />
        </div>
      ) : null}
      {!job.exportAvailable ? (
        <p className="text-sm text-text-secondary">{t('migration.sample.unavailable')}</p>
      ) : (
        <QueryState query={sample} label={t('migration.sample.loading')}>
          {(data) => (
            <div className="flex flex-col gap-3">
              {compare && data.comparison ? (
                <p data-testid="sample-comparison" data-matches={String(data.comparison.matches)}>
                  <StatusBadge tone={data.comparison.matches ? 'success' : 'warning'}>
                    {data.comparison.matches
                      ? t('migration.sample.matches')
                      : t('migration.sample.differs')}
                  </StatusBadge>
                  {data.comparison.problems.length > 0 ? (
                    <span className="ms-2 text-sm text-text-secondary">
                      {[...new Set(data.comparison.problems.map((p) => p.split(':')[0] as string))]
                        .map((p) =>
                          t(`migration.sample.problems.${p as 'order_or_count'}`, {
                            defaultValue: p,
                          }),
                        )
                        .join(' ')}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <div className={cn('grid gap-3', compare && 'lg:grid-cols-2')}>
                <Conversation
                  side={data.source}
                  label={t('migration.sample.source')}
                  testId="sample-source"
                />
                {compare ? (
                  data.imported ? (
                    <Conversation
                      side={data.imported}
                      label={t('migration.sample.imported')}
                      testId="sample-imported"
                    />
                  ) : (
                    <p className="rounded-lg border border-dashed border-border p-3 text-sm text-text-secondary">
                      {t('migration.sample.notYet')}
                    </p>
                  )
                ) : null}
              </div>
            </div>
          )}
        </QueryState>
      )}
    </div>
  );
}
