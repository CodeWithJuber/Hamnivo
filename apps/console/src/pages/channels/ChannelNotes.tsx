import { AlertCircleIcon, CheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import { isCancelled } from '../../lib/reauth';

/**
 * A failed change. When Chatwoot did not answer, the gateway says what was saved anyway (the
 * setting can be saved here while Chatwoot is not updated yet), so its words are shown.
 */
export function ChannelProblem({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error || isCancelled(error)) return null;
  if (!isApiError(error, 'AUTHORITY_UNAVAILABLE')) return <ActionError error={error} />;
  const detail = error.problem?.detail;
  return (
    <div
      role="alert"
      data-testid="action-error"
      className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm"
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-danger">{t('channels.chatwoot.title')}</p>
        {detail ? (
          <p className="text-text" data-testid="problem-detail">
            <bdi dir="auto">{detail}</bdi>
          </p>
        ) : null}
        <p className="text-text-secondary">{t('channels.chatwoot.description')}</p>
        {error.requestId ? (
          <p className="text-xs text-text-secondary">
            {t('app.reference')}:{' '}
            <bdi dir="ltr" className="font-mono">
              {error.requestId}
            </bdi>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** What a change did, next to the card (and read out by screen readers). */
export function SavedNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-success" data-testid="channel-saved">
      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
