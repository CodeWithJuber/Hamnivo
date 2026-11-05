import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Link } from '@tanstack/react-router';
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
 * The version that was live before the current one: of the versions that were published and
 * then retired, the one retired last. It is the usual one to roll back to.
 */
export function previousLive(versions: readonly AgentVersion[] | undefined): number | undefined {
  let found: AgentVersion | undefined;
  for (const version of versions ?? []) {
    if (version.state !== 'retired' || !version.configHash) continue;
    if (!found || version.updatedAt > found.updatedAt) found = version;
  }
  return found?.version;
}

/**
 * Every version, newest first, with its state, since when it is live (or was retired) and its
 * configuration hash. An earlier published version can be made live again (rollback, HNV-11-06):
 * the one live before the current one is marked, the dialog says what changes for customers, and
 * a link stops this agent's replies at once when something is wrong right now. The draft is kept.
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
  const previous = previousLive(versions.data?.items);

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
                  <span className="flex flex-wrap gap-1">
                    {version.version === previous ? (
                      <StatusBadge tone="info" icon={null} data-testid="previous-live">
                        {t('editor.versions.previous')}
                      </StatusBadge>
                    ) : null}
                    <StatusBadge tone={stateTone[version.state]}>
                      {t(`editor.versions.state.${version.state}`)}
                    </StatusBadge>
                  </span>
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
                {version.state === 'draft' ? null : (
                  <p className="text-xs font-medium text-text" data-testid="version-since">
                    {version.state === 'published'
                      ? t('editor.versions.liveSince', {
                          time: formatDateTime(version.updatedAt),
                        })
                      : t('editor.versions.retiredAt', {
                          time: formatDateTime(version.updatedAt),
                        })}
                  </p>
                )}
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
                    variant={version.version === previous ? 'default' : 'secondary'}
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
      {can('agents.publish') && publishedVersion !== null ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-sm">
          <span className="text-text-secondary">{t('editor.versions.emergency')}</span>
          <Link
            to="/stop-ai"
            className="font-medium text-link underline underline-offset-4 hover:no-underline"
            data-testid="versions-stop-ai"
          >
            {t('editor.versions.emergencyLink')}
          </Link>
        </p>
      ) : null}
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
          <p>
            {t('editor.versions.rollbackBody', {
              version: target,
              live: publishedVersion ?? '—',
            })}
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
