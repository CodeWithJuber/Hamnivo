import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useTenant } from '../../lib/tenant';

/**
 * Said in a chat's details panel when the brand has no tags to pick from: who can add them, and for
 * people who can, a link to the page where it is done (for the chat's own brand).
 */
export function NoTagsHint({ brandId }: { brandId: string | undefined }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  return (
    <p className="text-xs text-text-secondary" data-testid="no-tags-hint">
      {t('inbox.tags.noneDefined')}{' '}
      {can('inbox.manage') ? (
        <Link
          to="/saved-replies"
          search={brandId ? { brand: brandId } : {}}
          className="font-medium text-link underline underline-offset-2 hover:no-underline"
        >
          {t('inboxAlerts.library.hint.add')}
        </Link>
      ) : (
        t('inboxAlerts.library.hint.ask')
      )}
    </p>
  );
}
