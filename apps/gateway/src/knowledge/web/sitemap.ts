import { Parser } from 'htmlparser2';

export interface SitemapContents {
  /** `index`: it lists other sitemaps. `urlset`: it lists pages. */
  kind: 'index' | 'urlset' | 'unknown';
  urls: string[];
  sitemaps: string[];
}

const MAX_URLS = 5000;
const MAX_SITEMAPS = 50;

/**
 * Reads a sitemap (sitemaps.org): the pages of a `urlset`, or the sitemaps of a `sitemapindex`.
 * The parser reads text only: it never fetches or expands anything the document names, so a hostile
 * sitemap cannot do more than list addresses, and the caller still checks every one.
 */
export function parseSitemap(xml: string): SitemapContents {
  const result: SitemapContents = { kind: 'unknown', urls: [], sitemaps: [] };
  const stack: string[] = [];
  let text = '';
  const parser = new Parser(
    {
      onopentag(name) {
        stack.push(name);
        text = '';
        if (name === 'urlset') result.kind = 'urlset';
        if (name === 'sitemapindex') result.kind = 'index';
      },
      ontext(data) {
        if (text.length < 3000) text += data;
      },
      onclosetag(name) {
        if (name === 'loc') {
          const parent = stack.at(-2);
          const value = text.trim();
          if (value) {
            if (parent === 'url' && result.urls.length < MAX_URLS) result.urls.push(value);
            if (parent === 'sitemap' && result.sitemaps.length < MAX_SITEMAPS) {
              result.sitemaps.push(value);
            }
          }
        }
        stack.pop();
        text = '';
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  return result;
}
