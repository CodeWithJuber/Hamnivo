import { Button } from '@hamnivo/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The memory question (HNV-15-01): what would be remembered, why and for how long, with two equal
 * answers and nothing chosen in advance. Nothing is remembered until the customer says yes.
 */
export function MemoryConsent({
  maxRetentionDays,
  privacyPolicyUrl,
  onChoose,
  onLater,
}: {
  maxRetentionDays: number;
  privacyPolicyUrl: string | null;
  onChoose: (choice: 'granted' | 'declined') => Promise<void>;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'granted' | 'declined' | null>(null);
  const [failed, setFailed] = useState(false);
  const choose = async (choice: 'granted' | 'declined') => {
    setBusy(choice);
    setFailed(false);
    try {
      await onChoose(choice);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-labelledby="memory-consent-title"
      data-testid="memory-consent"
      className="mx-4 mb-3 flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 text-sm text-text shadow-sm"
    >
      <h2 id="memory-consent-title" className="text-[15px] font-semibold">
        {t('memory.consent.title')}
      </h2>
      <p>{t('memory.consent.what')}</p>
      <p>{t('memory.consent.never')}</p>
      <p>{t('memory.consent.control', { days: maxRetentionDays })}</p>
      {privacyPolicyUrl ? (
        <a
          href={privacyPolicyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-link underline underline-offset-2"
        >
          {t('memory.consent.privacy')}
        </a>
      ) : null}
      {failed ? (
        <p role="alert" className="text-danger">
          {t('memory.error')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          variant="secondary"
          className="min-h-11 flex-1"
          busy={busy === 'granted'}
          disabled={busy !== null}
          onClick={() => void choose('granted')}
        >
          {t('memory.consent.yes')}
        </Button>
        <Button
          variant="secondary"
          className="min-h-11 flex-1"
          busy={busy === 'declined'}
          disabled={busy !== null}
          onClick={() => void choose('declined')}
        >
          {t('memory.consent.no')}
        </Button>
      </div>
      <Button variant="link" className="h-auto self-start text-xs" onClick={onLater}>
        {t('memory.consent.later')}
      </Button>
    </section>
  );
}
