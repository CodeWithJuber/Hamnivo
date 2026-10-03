import { useTranslation } from 'react-i18next';
import type { InboxDetail } from '../../lib/inbox';

/**
 * "Maya is typing…" under the conversation. The line keeps its height when it is empty, so the
 * messages above do not jump, and it is not announced: a screen reader would repeat it all the
 * time the customer writes.
 */
export function CustomerTypingLine({ detail }: { detail: InboxDetail }) {
  const { t } = useTranslation();
  return (
    <p
      aria-live="off"
      className="min-h-6 px-4 pb-1 text-xs text-text-secondary"
      data-testid="customer-typing"
    >
      {detail.customerTyping
        ? t('inboxAlerts.typing.customer', { name: detail.customer.displayName })
        : null}
    </p>
  );
}
