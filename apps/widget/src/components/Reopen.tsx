import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * "I still need help" on a closed conversation (W15): opens it again with its history. Success is
 * said politely; the message box is where to go next.
 */
export function Reopen({ onReopen }: { onReopen: () => Promise<void> }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reopen = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onReopen();
      announce(t('surface.reopen.done'));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="min-h-11"
        busy={busy}
        onClick={() => void reopen()}
        data-testid="reopen"
      >
        {t('surface.reopen.button')}
      </Button>
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t('surface.reopen.failed')}
        </p>
      ) : null}
    </div>
  );
}
