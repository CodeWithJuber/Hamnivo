import { useTranslation } from 'react-i18next';

/**
 * "Amina is typing…" above the composer while a person writes a reply. It is not read out: a
 * screen reader would repeat it every time the person starts again, and the reply itself is
 * announced when it arrives. The name is isolated, so it reads right inside a sentence in the
 * other direction.
 */
export function StaffTypingLine({ name }: { name: string | null }) {
  const { t } = useTranslation();
  if (name === null) return null;
  return (
    <p aria-live="off" className="mb-1 text-xs text-text-muted" data-testid="person-typing">
      {name ? t('personTyping', { name: `⁨${name}⁩` }) : t('aPersonTyping')}
    </p>
  );
}
