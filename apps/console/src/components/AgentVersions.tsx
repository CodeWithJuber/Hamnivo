import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { HistoryIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../lib/format';
import { useNames } from '../lib/names';
import { useAgentVersions } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { AgentVersion } from '../lib/types';
import { ConfirmDialog } from './AppDialog';
import { QueryState } from './States';

const stateTone: Record<AgentVersion['state'], StatusTone> = {
  draft: 'info',
  published: 'success',
  retired: 'neutral',
};

/**
 * Every version, newest first, with its state and configuration hash. An earlier published
 * version can be made live again (rollback); the draft is kept.
 */
export function AgentVersions({
  agentId,
  publishedVersion,
  onRollback,
}: {
  agentId: string;
  publishedVersion: number | null;
  onRollback: (version: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const names = useNames();
  const versions = useAgentVersions(agentId);
  const [target, setTarget] = useState<number | null>(null);

  return (
    <section
      aria-labelledby="versions-title"
      data-testid="versions"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6 xl:sticky xl:top-20"
    >
      <h2
        id="versions-title"
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-semibold text-text"
      >
        <HistoryIcon className="size-5 text-text-muted" aria-hidden="true" />
        {t('editor.versions.title')}
      </h2>
      <QueryState
        query={versions}
        label={t('editor.versions.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('editor.versions.empty')}</p>}
      >
        {(data) => (
          <ol className="flex flex-col gap-3">
            {data.items.map((version) => (
              <li
                key={version.id}
                data-version={version.version}
                data-state={version.state}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text">
                    {t('editor.versions.version', { version: version.version })}
                  </span>
                  <StatusBadge tone={stateTone[version.state]}>
                    {t(`editor.versions.state.${version.state}`)}
                  </StatusBadge>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-text-secondary">{t('editor.versions.hash')}</dt>
                  <dd className="min-w-0">
                    {version.configHash ? (
                      <bdi
                        dir="ltr"
                        className="block truncate font-mono text-text"
                        title={version.configHash}
                      >
                        {version.configHash.slice(0, 16)}
                      </bdi>
                    ) : (
                      <span className="text-text-secondary">{t('editor.versions.noHash')}</span>
                    )}
                  </dd>
                </dl>
                <p className="text-xs text-text-secondary">
                  {version.publishedAt
                    ? t('editor.versions.publishedAt', {
                        time: formatDateTime(version.publishedAt),
                      })
                    : t('editor.versions.created', { time: formatDateTime(version.createdAt) })}
                  {version.publishedBy && names.member(version.publishedBy) ? (
                    <>
                      {' '}
                      · <bdi>{names.member(version.publishedBy)}</bdi>
                    </>
                  ) : null}
                </p>
                {version.state === 'retired' &&
                version.configHash &&
                version.version !== publishedVersion &&
                can('agents.publish') ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    onClick={() => setTarget(version.version)}
                  >
                    {t('editor.versions.rollback', { version: version.version })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </QueryState>
      {target !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={t('editor.versions.rollbackTitle', { version: target })}
          confirmLabel={t('editor.versions.rollbackSubmit')}
          testId="rollback-dialog"
          onConfirm={() => onRollback(target)}
          fallbackFocus={() => document.getElementById('versions-title')}
        >
          <p>{t('editor.versions.rollbackBody', { version: target })}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
