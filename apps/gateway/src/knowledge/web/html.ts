import { Parser } from 'htmlparser2';
import { normalizePageUrl } from './urls.js';

export interface PageLink {
  url: string;
}

export interface PageInfo {
  title: string | null;
  /** Same-page and cross-site links included; the caller keeps what it may follow. */
  links: PageLink[];
  /** The page asks not to be indexed (`<meta name="robots" content="noindex">`). */
  noindex: boolean;
  /** The page asks that its links not be followed. */
  nofollow: boolean;
  /** The address the page says is its main one, when it differs. */
  canonical: string | null;
}

const MAX_LINKS = 1500;
const MAX_TITLE = 300;

/** The robots meta tags that speak to Hamnivo's reader. */
const ROBOT_NAMES = new Set(['robots', 'hamnivobot']);

/**
 * What a page says about itself, in one pass: its title (or first heading), the addresses it links
 * to, and whether it asks not to be indexed or followed. The page is untrusted text; nothing here
 * runs it. Links are resolved against the page's own address.
 */
export function scanPage(html: string, pageUrl: string): PageInfo {
  let title = '';
  let heading = '';
  let inTitle = false;
  let titleDone = false;
  let inHeading = false;
  let headingDone = false;
  let noindex = false;
  let nofollow = false;
  let canonical: string | null = null;
  const links: PageLink[] = [];
  const seen = new Set<string>();

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        switch (name) {
          case 'title':
            if (!titleDone) inTitle = true;
            break;
          case 'h1':
            if (!headingDone) inHeading = true;
            break;
          case 'meta': {
            const meta = (attribs.name ?? '').toLowerCase();
            if (ROBOT_NAMES.has(meta)) {
              const content = (attribs.content ?? '').toLowerCase();
              if (/\b(noindex|none)\b/.test(content)) noindex = true;
              if (/\b(nofollow|none)\b/.test(content)) nofollow = true;
            }
            break;
          }
          case 'link':
            if (/\bcanonical\b/i.test(attribs.rel ?? '') && attribs.href) {
              canonical = normalizePageUrl(attribs.href, pageUrl);
            }
            break;
          case 'a': {
            const href = attribs.href;
            if (!href || links.length >= MAX_LINKS) break;
            if (/\bnofollow\b/i.test(attribs.rel ?? '')) break;
            const url = normalizePageUrl(href, pageUrl);
            if (url && !seen.has(url)) {
              seen.add(url);
              links.push({ url });
            }
            break;
          }
        }
      },
      ontext(text) {
        if (inTitle && title.length < MAX_TITLE) title += text;
        if (inHeading && heading.length < MAX_TITLE) heading += text;
      },
      onclosetag(name) {
        if (name === 'title') {
          inTitle = false;
          titleDone = true;
        }
        if (name === 'h1') {
          inHeading = false;
          headingDone = true;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return {
    title: clean(title) || clean(heading) || null,
    links,
    noindex,
    nofollow,
    canonical,
  };
}
