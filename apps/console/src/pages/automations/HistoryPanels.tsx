import { Button } from '@hamnivo/ui/components/button';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { HistoryIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/AppDialog';
import { Section } from '../../components/PageHeader';
import { QueryState } from '../../components/States';
import {
  type Automation,
  type AutomationRun,
  type AutomationVersion,
  useAutomationRuns,
  useAutomationVersions,
} from '../../lib/automations';
import { formatDateTime, formatRelative } from '../../lib/format';

/** Who published a version, and when, in words. */
export function publishedText(
  version: Pick<AutomationVersion, 'publishedAt' | 'publishedBy' | 'publishedByName'>,
  t: TFunction,
): string {
  const when = formatRelative(version.publishedAt);
  return version.publishedBy === null
    ? t('automations.editor.versions.bySystem', { when })
    : t('automations.editor.versions.by', {
        who: version.publishedByName ?? version.publishedBy,
        when,
      });
}

/** The versions a rule was published as, each of which can be copied back into the draft. */
export function VersionsPanel({
  automation,
  restoreReason,
  onRestore,
}: {
  automation: Automation;
  /** Why restoring is not possible now (no permission, or changes not saved), or null. */
  restoreReason: string | null;
  onRestore: (version: number) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const versions = useAutomationVersions(automation.id);
  const [restoring, setRestoring] = useState<number | null>(null);
  return (
    <Section
      id="automation-versions"
      title={t('automations.editor.versions.title')}
      description={t('automations.editor.versions.description')}
    >
      <QueryState query={versions} label={t('automations.editor.versions.title')}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('automations.editor.versions.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-2" data-testid="automation-versions">
              {data.items.map((version) => (
                <li
                  key={version.version}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  data-testid="automation-version"
                  data-version={version.version}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-medium text-text">
                      {t('automations.editor.versions.version', { version: version.version })}
                      {automation.published?.version === version.version ? (
                        <StatusBadge tone="success">
                          {t('automations.editor.versions.current')}
                        </StatusBadge>
                      ) : null}
                    </span>
                    <span className="text-sm text-text-secondary">
                      <bdi>{version.name}</bdi> · {publishedText(version, t)}
                    </span>
                  </div>
                  <ReasonedAction reason={restoreReason}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={t('automations.editor.versions.restoreLabel', {
                        version: version.version,
                      })}
                      onClick={() => setRestoring(version.version)}
                    >
                      <HistoryIcon aria-hidden="true" />
                      {t('automations.editor.versions.restore')}
                    </Button>
                  </ReasonedAction>
                </li>
              ))}
            </ol>
          )
        }
      </QueryState>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title={t('automations.editor.versions.restoreTitle', { version: restoring ?? 0 })}
        confirmLabel={t('automations.editor.versions.restoreConfirm')}
        testId="restore-version-dialog"
        onConfirm={() => onRestore(restoring ?? 0)}
      >
        <p>{t('automations.editor.versions.restoreBody', { version: restoring ?? 0 })}</p>
      </ConfirmDialog>
    </Section>
  );
}

const OUTCOME_TONES: Record<AutomationRun['outcome'], StatusTone> = {
  done: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

/** What a chat rule did lately: when, in which chat, which actions, and why when it held back. */
export function RunsPanel({ automation }: { automation: Automation }) {
  const { t } = useTranslation();
  const runs = useAutomationRuns(automation.id, automation.kind === 'conversation');
  const reasonText = (reason: string) =>
    reason in { ai_has_chat: 1, message_limit: 1, no_bot: 1 }
      ? t(`automations.editor.runs.reasons.${reason as 'ai_has_chat'}`)
      : reason;
  return (
    <Section
      id="automation-runs"
      title={t('automations.editor.runs.title')}
      description={t('automations.editor.runs.description')}
    >
      <QueryState query={runs} label={t('automations.editor.runs.title')}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('automations.editor.runs.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm" data-testid="automation-runs">
                <thead>
                  <tr className="border-b border-border text-text-secondary">
                    <th scope="col" className="p-2 text-start font-medium">
                      {t('automations.editor.runs.when')}
                    </th>
                    <th scope="col" className="p-2 text-start font-medium">
                      {t('automations.editor.runs.chat')}
                    </th>
                    <th scope="col" className="p-2 text-start font-medium">
                      {t('automations.editor.runs.actions')}
                    </th>
                    <th scope="col" className="p-2 text-start font-medium">
                      {t('automations.editor.runs.result')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((run) => (
                    <tr key={run.id} className="border-b border-border align-top last:border-0">
                      <td className="p-2">
                        <time dateTime={run.ranAt} title={formatDateTime(run.ranAt)}>
                          {formatRelative(run.ranAt)}
                        </time>
                        <span className="block text-xs text-text-secondary">
                          {t('automations.editor.runs.version', { version: run.version })}
                        </span>
                      </td>
                      <td className="p-2">
                        {run.conversationId ? (
                          <Link
                            to="/inbox/$conversationId"
                            params={{ conversationId: run.conversationId }}
                            className="text-link underline underline-offset-4 hover:no-underline"
                          >
                            {t('automations.editor.runs.open')}
                          </Link>
                        ) : (
                          t('automations.editor.runs.noChat')
                        )}
                      </td>
                      <td className="p-2">
                        {run.actions.length === 0
                          ? t('automations.editor.runs.noActions')
                          : run.actions
                              .map((action) =>
                                t(`automations.editor.actions.${action as 'make_ticket'}`, {
                                  defaultValue: action,
                                }),
                              )
                              .join(', ')}
                      </td>
                      <td className="flex flex-col items-start gap-1 p-2">
                        <StatusBadge tone={OUTCOME_TONES[run.outcome]}>
                          {t(`automations.editor.runs.outcomes.${run.outcome}`)}
                        </StatusBadge>
                        {run.reason ? (
                          <span className="text-xs text-text-secondary">
                            {reasonText(run.reason)}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </QueryState>
    </Section>
  );
}
