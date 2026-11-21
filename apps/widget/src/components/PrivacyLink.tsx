import { useTranslation } from 'react-i18next';

/** A web address the chat may link to (http or https only), or null. */
export function webHref(url: string | null | undefined): string | null {
  try {
    return url && /^https?:$/.test(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The small print under the message box, on one line: the brand's privacy policy (only a web
 * address is linked) and, unless the brand turned it off, Hamnivo's name.
 */
export function FinePrint({ url, branded }: { url: string | null; branded: boolean }) {
  const { t } = useTranslation();
  const href = webHref(url);
  if (!href && !branded) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] text-text-muted">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-text-muted underline underline-offset-2 hover:text-text"
          data-testid="privacy-link"
        >
          {t('appearance.privacy')}
        </a>
      ) : null}
      {href && branded ? <span aria-hidden="true">·</span> : null}
      {branded ? <span data-testid="widget-branding">Hamnivo</span> : null}
    </p>
  );
}
