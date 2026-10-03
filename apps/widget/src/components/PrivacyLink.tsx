import { useTranslation } from 'react-i18next';

/** The brand's privacy policy, as a link under the message box. Only a web address is linked. */
export function PrivacyLink({ url }: { url: string | null }) {
  const { t } = useTranslation();
  let href: string | null = null;
  try {
    href = url && /^https?:$/.test(new URL(url).protocol) ? url : null;
  } catch {
    href = null;
  }
  if (!href) return null;
  return (
    <p className="mt-1 text-center text-xs text-text-muted">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-link underline underline-offset-2"
        data-testid="privacy-link"
      >
        {t('appearance.privacy')}
      </a>
    </p>
  );
}
