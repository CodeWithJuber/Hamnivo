/**
 * Addresses of the pages of a website that is read as knowledge. A page is known by one address:
 * absolute, without a fragment, with the host in lower case and without a default port, so the same
 * page reached by two links is read once. Only web addresses without a password in them count.
 */
export function normalizePageUrl(href: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  const text = url.href;
  return text.length <= 2000 ? text : null;
}

export function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Whether two addresses are the same page apart from the query string and a closing slash. */
export function samePath(a: string, b: string): boolean {
  try {
    const trim = (url: string) => new URL(url).pathname.replace(/\/+$/, '');
    return trim(a) === trim(b);
  } catch {
    return false;
  }
}

/**
 * The part of a site a read stays in: the folder of the address it started from. A home page
 * (`/`) covers the whole site; `/help/` and `/help` and `/help/start.html` cover `/help/`.
 */
export function folderOf(startUrl: string): string {
  const { pathname } = new URL(startUrl);
  if (pathname === '' || pathname === '/') return '/';
  if (pathname.endsWith('/')) return pathname;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (/^index\.[a-z0-9]+$/i.test(last)) {
    const folder = pathname.slice(0, pathname.lastIndexOf('/') + 1);
    return folder === '' ? '/' : folder;
  }
  if (last.includes('.')) return pathname.slice(0, pathname.lastIndexOf('/') + 1) || '/';
  return `${pathname}/`;
}

export function inFolder(url: string, folder: string): boolean {
  try {
    return new URL(url).pathname.startsWith(folder);
  } catch {
    return false;
  }
}

/** Files that are not pages: links to them are not followed. PDF is a page: it has text. */
const NOT_PAGES =
  /\.(?:jpe?g|png|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|rar|7z|mp3|mp4|m4a|mov|avi|webm|wav|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;

export function looksLikePage(url: string): boolean {
  try {
    return !NOT_PAGES.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** A short name for a page without a title: the last part of its address. */
export function nameFromUrl(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (!last) return hostname;
    const readable = decodeURIComponent(last)
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim();
    return readable || hostname;
  } catch {
    return url.slice(0, 120);
  }
}
