import { Button } from '@hamnivo/ui/components/button';
import { useTranslation } from 'react-i18next';
import type { Custom } from './model.js';

/** Why a message was not sent, in words a customer can act on (HNV-06-03). */
function causeOf(
  code: string | undefined,
): 'files' | 'invalid' | 'closed' | 'unavailable' | 'other' {
  if (code === 'CHAT_UNAVAILABLE') return 'unavailable';
  if (code === 'UPLOAD_REJECTED' || code === 'FEATURE_DISABLED') return 'files';
  if (code === 'VALIDATION_FAILED' || code === 'IDEMPOTENCY_CONFLICT') return 'invalid';
  if (code === 'NOT_FOUND' || code === 'CONVERSATION_CLOSED') return 'closed';
  return 'other';
}

/**
 * When a message was sent, in the visitor's own time zone. Only the time: the day is said once,
 * on the line above that day's first message. Nothing for a message not confirmed yet.
 */
export function SentAt({ at, locale }: { at: string | undefined; locale: string }) {
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} data-testid="sent-at">
      {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)}
    </time>
  );
}

/** "Waiting", "Sending…", "Not sent" with what to do, or "Sent" and "Read" (W06). */
export function Delivery(props: {
  custom: Partial<Custom>;
  offline: boolean;
  /** Chat isn't available to this visitor (H20): sending again or editing can't help. */
  readOnly: boolean;
  onRetry: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { custom } = props;
  const id = custom.clientMessageId;
  if (custom.state === 'failed' && id) {
    const cause = causeOf(custom.errorCode);
    // While chat isn't available, sending again or editing can't help; the message can go.
    const stuck = cause === 'unavailable' || props.readOnly;
    return (
      <div className="flex max-w-[85%] flex-col items-end gap-1 text-xs" role="alert">
        <span className="text-danger">
          {t('surface.delivery.failed')} {t(`surface.delivery.causes.${cause}`)}
        </span>
        <span className="flex flex-wrap justify-end gap-3">
          {stuck ? null : (
            <>
              <Button variant="link" className="h-auto text-xs" onClick={() => props.onRetry(id)}>
                {t('surface.delivery.retry')}
              </Button>
              <Button variant="link" className="h-auto text-xs" onClick={() => props.onEdit(id)}>
                {t('surface.delivery.edit')}
              </Button>
            </>
          )}
          <Button variant="link" className="h-auto text-xs" onClick={() => props.onRemove(id)}>
            {t('surface.delivery.remove')}
          </Button>
        </span>
      </div>
    );
  }
  if (custom.state === 'queued' || custom.state === 'sending') {
    const waiting = custom.state === 'queued' && props.offline;
    return (
      <p
        className="flex flex-wrap items-center justify-end gap-3 text-xs text-text-muted"
        data-testid="delivery"
      >
        <span>{waiting ? t('surface.delivery.queued') : t('surface.delivery.sending')}</span>
        {waiting && id ? (
          <>
            <Button variant="link" className="h-auto text-xs" onClick={() => props.onEdit(id)}>
              {t('surface.delivery.edit')}
            </Button>
            <Button variant="link" className="h-auto text-xs" onClick={() => props.onRemove(id)}>
              {t('surface.delivery.remove')}
            </Button>
          </>
        ) : null}
      </p>
    );
  }
  if (custom.lastMine) {
    return (
      <p className="text-xs text-text-muted" data-testid="delivery">
        {custom.delivery === 'read' ? t('surface.delivery.read') : t('surface.delivery.sent')}
      </p>
    );
  }
  return null;
}
