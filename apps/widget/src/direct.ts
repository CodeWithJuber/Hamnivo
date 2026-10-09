/**
 * The brand's direct chat link (W28): the chat as a page of its own at `/c/<widgetId>`, for a
 * link in an email, a QR code or a social profile, with no website around it.
 */

/** The widget id in a direct chat link's path, or null for any other page. */
export function directWidgetId(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Keeps the page out of search results: it is one brand's chat, not a page to find. */
export function noIndex(doc: Document): void {
  if (doc.querySelector('meta[name="robots"]')) return;
  const meta = doc.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex';
  doc.head.append(meta);
}
