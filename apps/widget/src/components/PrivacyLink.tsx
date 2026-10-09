import { useTranslation } from 'react-i18next';

/** A web address the chat may link to (http or https only), or null. */
export function webHref(url: string | null | undefined): string | null {
  try {
    return url && /^https?:$/.test(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The brand's privacy policy, as a link under the message box. Only a web address is linked. */
export function PrivacyLink({ url }: { url: string | null }) {
  const { t } = useTranslation();
  const href = webHref(url);
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
