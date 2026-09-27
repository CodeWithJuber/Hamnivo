/**
 * Accessibility audit of the built Storybook (run `storybook build` first).
 * Every story is rendered in Chromium in light/dark × LTR/RTL and checked with axe-core against
 * WCAG 2.0/2.1/2.2 A and AA rules. Any violation fails the run. This is automated evidence only;
 * manual keyboard and screen-reader checks are still required (HNV-24-06).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Page } from 'playwright';

const root = fileURLToPath(new URL('../storybook-static/', import.meta.url));
if (!existsSync(join(root, 'index.json'))) {
  console.error('storybook-static/ is missing; run `pnpm build-storybook` first.');
  process.exit(1);
}

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(
    /^([/\\])+/,
    '',
  );
  const file = join(root, path || 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as {
  entries: Record<string, { type: string; id: string }>;
};
const stories = Object.values(index.entries).filter((e) => e.type === 'story');
const executablePath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
const variants = [
  { theme: 'light', direction: 'ltr' },
  { theme: 'dark', direction: 'ltr' },
  { theme: 'light', direction: 'rtl' },
  { theme: 'dark', direction: 'rtl' },
] as const;

/** One axe run; waits and tries again while another run in the page is still going. */
async function analyze(page: Page) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new AxeBuilder({ page })
        .include('#storybook-root')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        // Stories render fragments, not whole pages.
        .disableRules(['region', 'landmark-one-main', 'page-has-heading-one'])
        .analyze();
    } catch (error) {
      if (attempt >= 10 || !String(error).includes('Axe is already running')) throw error;
      await page.waitForTimeout(200);
    }
  }
}

let failures = 0;
for (const story of stories) {
  for (const variant of variants) {
    // axe-core/playwright requires pages created from an explicit browser context.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // a11y.manual stops the addon's own axe run after render, which would race with this one.
    const url = `${base}/iframe.html?id=${story.id}&viewMode=story&globals=theme:${variant.theme};direction:${variant.direction};a11y.manual:!true`;
    await page.goto(url);
    await page.waitForSelector('#storybook-root > *', { timeout: 15_000 });
    await page.waitForFunction(
      (v) =>
        document.documentElement.dataset.theme === v.theme &&
        document.documentElement.dir === v.direction,
      variant,
    );
    const result = await analyze(page);
    for (const violation of result.violations) {
      failures++;
      const targets = violation.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ');
      console.error(
        `✗ ${story.id} [${variant.theme}/${variant.direction}] ${violation.id}: ${violation.help} → ${targets}`,
      );
    }
    await context.close();
  }
}
await browser.close();
server.close();
console.log(
  `${stories.length} stories × ${variants.length} variants audited; ${failures} violation(s).`,
);
process.exit(failures ? 1 : 0);
