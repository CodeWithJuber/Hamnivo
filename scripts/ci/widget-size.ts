/**
 * The chat's first open stays light: the JavaScript the chat page loads before anything is clicked
 * (its module script and every chunk it preloads) must fit a gzip budget, or the check fails. Lazy
 * chunks (memory, settings, emoji, lightbox, commerce cards) are not counted: they load on demand.
 *
 * The loader that runs on customers' websites has its own, smaller budget
 * (packages/widget-loader/test/size.test.ts). Sizes are in kB of 1,000 bytes, as Vite prints them.
 *
 *   pnpm --filter @hamnivo/widget build && pnpm exec tsx scripts/ci/widget-size.ts
 *
 * The production-ready plan (2026-11-20) sets the target at 150 kB, by way of 200 kB. The budget
 * holds today's size so the chat cannot grow, and comes down as the first open is split.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Bytes of gzip, as a web server sends them (zlib's default level, as the loader's test uses). */
export const BUDGET = 290_000;

const DIST = fileURLToPath(new URL('../../apps/widget/dist/', import.meta.url));

/** The scripts the page loads at once: its module entry and the chunks it preloads, in order. */
export function firstOpenScripts(html: string): string[] {
  const found: string[] = [];
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const text = tag[0];
    const attr = (name: string) => text.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1];
    const src = tag[1] === 'script' && attr('type') === 'module' ? attr('src') : undefined;
    const href = tag[1] === 'link' && attr('rel') === 'modulepreload' ? attr('href') : undefined;
    if (src) found.push(src);
    if (href) found.push(href);
  }
  return found;
}

function main(): void {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const scripts = firstOpenScripts(html);
  if (scripts.length === 0) {
    console.error('apps/widget/dist/index.html loads no module script: was the widget built?');
    process.exit(1);
  }
  const sizes = scripts.map((src) => ({
    src,
    gzip: gzipSync(readFileSync(join(DIST, src.replace(/^\//, '')))).length,
  }));
  const total = sizes.reduce((sum, file) => sum + file.gzip, 0);
  const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;
  for (const file of [...sizes].sort((a, b) => b.gzip - a.gzip))
    console.log(`${kB(file.gzip).padStart(10)}  ${file.src}`);
  console.log(`${kB(total).padStart(10)}  first open, gzip (budget ${kB(BUDGET)})`);
  if (total > BUDGET) {
    console.error(
      `The chat's first open is ${kB(total)} of JavaScript, over its ${kB(BUDGET)} budget. Load the new code on demand (a dynamic import) instead.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
