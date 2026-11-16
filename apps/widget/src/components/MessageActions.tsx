import { HamnivoApiError } from '@hamnivo/client';
import type { ReactionEmoji } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const EMOJI_NAMES: Record<ReactionEmoji, 'thumbsUp' | 'thumbsDown' | 'heart' | 'thanks' | 'smile'> =
  {
    '👍': 'thumbsUp',
    '👎': 'thumbsDown',
    '❤️': 'heart',
    '🙏': 'thanks',
    '😊': 'smile',
  };

/**
 * Deletes one of the visitor's own messages after asking (W23). Where the time is over or the
 * chat cannot delete, the visitor is told so instead.
 */
export function DeleteMessage({ onDelete }: { onDelete: () => Promise<void> }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setAsking(false);
      announce(t('surface.actions.deleted'));
    } catch (caught) {
      const code = caught instanceof HamnivoApiError ? caught.code : '';
      setError(
        code === 'DELETE_WINDOW_CLOSED' || code === 'FEATURE_DISABLED'
          ? t('surface.actions.deleteClosed')
          : code === 'CAPABILITY_UNSUPPORTED'
            ? t('surface.actions.deleteUnsupported')
            : t('surface.actions.deleteFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!asking) {
    return (
      <Button
        variant="link"
        className="h-auto min-h-6 px-0 text-xs text-text-muted"
        aria-label={t('surface.actions.deleteLabel')}
        onClick={() => setAsking(true)}
      >
        {t('surface.actions.delete')}
      </Button>
    );
  }
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1 text-xs" data-testid="delete-confirm">
      <p className="text-text">{t('surface.actions.deleteConfirm')}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
          {t('surface.actions.cancel')}
        </Button>
        <Button size="sm" variant="destructive" busy={busy} onClick={() => void run()}>
          {t('surface.actions.deleteYes')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { EMOJI_NAMES };
