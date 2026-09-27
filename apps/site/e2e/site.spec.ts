import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { productVisuals } from '@hamnivo/brand';
import { expect, type Page, test } from '@playwright/test';

const PAGES = [
  { locale: 'en', path: '/', dir: 'ltr' },
  { locale: 'ar', path: '/ar/', dir: 'rtl' },
  { locale: 'hi', path: '/hi/', dir: 'ltr' },
  { locale: 'ur', path: '/ur/', dir: 'rtl' },
] as const;

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Scrolls through the page so lazy images load, then waits until every image has loaded. */
async function loadAllImages(page: Page) {
  await page.evaluate(async () => {
    // Instant, because the page asks for smooth scrolling.
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    await Promise.all(
      [...document.images].map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => {
              img.addEventListener('load', resolve);
              img.addEventListener('error', resolve);
            }),
      ),
    );
  });
  const broken = await page
    .locator('img')
    .evaluateAll((imgs) =>
      imgs.filter((img) => !(img as HTMLImageElement).naturalWidth).map((img) => img.outerHTML),
    );
  expect(broken).toEqual([]);
}

for (const { locale, path, dir } of PAGES) {
  test.describe(`${locale} page (${path})`, () => {
    for (const width of [1280, 320]) {
      test(`has no WCAG 2.2 AA violations at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
        expect(
          results.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
          ),
        ).toEqual([]);
      });
    }

    test('sets lang and dir on the document', async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
    });

    test('has one h1, landmarks and a working skip link', async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('header')).toHaveCount(1);
      await expect(page.locator('main#main')).toHaveCount(1);
      await expect(page.locator('footer')).toHaveCount(1);
      await page.keyboard.press('Tab');
      const skip = page.locator('a.skip-link');
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page.locator('main#main')).toBeFocused();
    });

    test('gives every image alt text, using the brand alt text for the visuals', async ({
      page,
    }) => {
      await page.goto(path);
      const images = await page
        .locator('img')
        .evaluateAll((imgs) =>
          imgs.map((img) => ({ alt: img.getAttribute('alt'), width: img.getAttribute('width') })),
        );
      expect(images.length).toBeGreaterThan(productVisuals.length);
      for (const image of images) {
        expect(image.alt?.trim()).toBeTruthy();
        expect(image.width).toBeTruthy();
      }
      const alts = images.map((image) => image.alt);
      for (const visual of productVisuals) expect(alts).toContain(visual.alt[locale]);
    });

    test('loads only the hero image eagerly', async ({ page }) => {
      await page.goto(path);
      const loading = await page
        .locator('img')
        .evaluateAll((imgs) => imgs.map((img) => img.getAttribute('loading')));
      expect(loading[0]).toBe('eager');
      expect(loading.slice(1).every((value) => value === 'lazy')).toBe(true);
      await expect(page.locator('img').first()).toHaveAttribute('fetchpriority', 'high');
      await expect(page.locator('picture source[type="image/avif"]')).toHaveCount(
        productVisuals.length,
      );
    });

    test('has no horizontal overflow at 320 px', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(path);
      await loadAllImages(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });

    test('does not shift the layout while loading', async ({ page }) => {
      await page.goto(path);
      await loadAllImages(page);
      const shift = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let total = 0;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as unknown as {
                value: number;
                hadRecentInput: boolean;
              }[]) {
                if (!entry.hadRecentInput) total += entry.value;
              }
            }).observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => resolve(total), 300);
          }),
      );
      expect(shift).toBeLessThan(0.01);
    });

    test('has a language switcher whose links all resolve', async ({ page, request }) => {
      await page.goto(path);
      const links = page.locator('header nav a[hreflang]');
      await expect(links).toHaveCount(PAGES.length);
      await expect(links.and(page.locator('[aria-current="page"]'))).toHaveAttribute('href', path);
      for (const link of await links.all()) {
        const href = await link.getAttribute('href');
        const target = PAGES.find((p) => p.path === href);
        expect(target, `unexpected switcher link ${href}`).toBeDefined();
        await expect(link).toHaveAttribute('lang', target?.locale ?? '');
        const response = await request.get(href ?? '');
        expect(response.status()).toBe(200);
        expect(await response.text()).toContain(`<html lang="${target?.locale}"`);
      }
    });

    test('declares canonical and hreflang alternates for every language', async ({ page }) => {
      await page.goto(path);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
      const origin = new URL(canonical ?? '').origin;
      expect(canonical).toBe(`${origin}${path}`);
      const alternates = await page
        .locator('link[rel="alternate"][hreflang]')
        .evaluateAll((links) =>
          links.map((link) => [link.getAttribute('hreflang'), link.getAttribute('href')]),
        );
      expect(alternates).toEqual([
        ...PAGES.map((p) => [p.locale, `${origin}${p.path}`]),
        ['x-default', `${origin}/`],
      ]);
    });

    test('links its description, social image, icons and manifest', async ({ page, request }) => {
      await page.goto(path);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S/);
      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
      expect(ogImage).toMatch(/^https?:\/\/.+\/og-image\.png$/);
      const files = [
        new URL(ogImage ?? '').pathname,
        '/favicon.ico',
        '/favicon.svg',
        '/apple-touch-icon.png',
        '/site.webmanifest',
        '/icon-192.png',
        '/robots.txt',
      ];
      for (const file of files) expect((await request.get(file)).status(), file).toBe(200);
    });
  });
}

test('generates a sitemap that lists every language', async ({ request }) => {
  const index = await request.get('/sitemap-index.xml');
  expect(index.status()).toBe(200);
  const sitemapUrl = /<loc>([^<]+)<\/loc>/.exec(await index.text())?.[1] ?? '';
  const sitemap = await request.get(new URL(sitemapUrl).pathname);
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  const origin = new URL(sitemapUrl).origin;
  for (const { locale, path } of PAGES) {
    expect(xml).toContain(`<loc>${origin}${path}</loc>`);
    expect(xml).toContain(`hreflang="${locale}" href="${origin}${path}"`);
  }
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain(`Sitemap: ${origin}/sitemap-index.xml`);
});

test('copies the install snippet', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#demo');
  const button = page.locator('button[data-copy="loader-snippet"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('[data-copy-status="loader-snippet"]')).toHaveText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await page.locator('#loader-snippet').textContent());
  expect(copied).toContain('data-widget-id=');
});

test.describe('review screenshots', () => {
  test.skip(!process.env.SITE_SCREENSHOTS, 'Set SITE_SCREENSHOTS=1 to write e2e/screenshots/.');
  for (const { locale, path } of PAGES.filter((p) => p.locale === 'en' || p.locale === 'ar')) {
    for (const [width, height] of [
      [1440, 1024],
      [390, 844],
    ] as const) {
      test(`${locale} at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await loadAllImages(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: fileURLToPath(new URL(`./screenshots/${locale}-${width}.png`, import.meta.url)),
          fullPage: true,
        });
      });
    }
  }
});
