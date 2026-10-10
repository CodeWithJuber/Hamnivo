/**
 * Studio's header on a phone: one row in every language at 320 and 390 px, with Search and Stop
 * AI in reach and the language in the menu sheet. Wider screens keep the language in the header.
 */
import { expect, test } from '@playwright/test';
import { audit, seedWorkspace } from './support';

const shots = process.env.E2E_SCREENSHOTS;

// The header's own height (min-h-16): a second row would make it taller.
const ONE_ROW = 64;

test('on a phone the header is one row in every language, with Search and Stop AI in reach', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  for (const lang of ['en', 'ar', 'hi', 'ur'] as const) {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/overview?lang=${lang}`);
      await expect(page.locator('h1').first()).toBeVisible();
      const header = page.locator('header').first();
      const height = await header.evaluate((el) => el.getBoundingClientRect().height);
      expect(height, `${lang} at ${width}px`).toBeLessThanOrEqual(ONE_ROW);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `${lang} at ${width}px`).toBeLessThanOrEqual(1);
      // Stop AI stays a visible red button with its full name, only its icon showing.
      await expect(page.getByTestId('stop-ai-button')).toBeVisible();
      await expect(page.getByTestId('palette-button')).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/header-${lang}-${width}.png` });
    }
  }
  await page.goto('/overview?lang=en');
  await expect(page.getByTestId('stop-ai-button')).toHaveAccessibleName('Stop AI replies');
  // The language is not in the header on a phone…
  await expect(page.locator('#studio-language')).toBeHidden();
  expect(await audit(page, 'header at 320 px')).toEqual([]);
});

test('on a phone the language is chosen in the menu, and a menu link leaves focus on the new page', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/overview?lang=en');
  await expect(page.locator('h1').first()).toBeVisible();

  await page.getByRole('button', { name: 'Open menu' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Language').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // The sheet moves to the right-hand side for Arabic, and ends up wholly on the screen.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const box = await sheet.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390 && box.x > 0).toBe(true);
  await expect(sheet.getByLabel('اللغة')).toBeInViewport();
  if (shots) await page.screenshot({ path: `${shots}/menu-sheet-ar-390.png` });

  // Following a link closes the sheet, and the new page's heading has focus, as on a desktop.
  await sheet.getByRole('navigation').getByRole('link').nth(1).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(sheet).toBeHidden();
  await expect(page.locator('#page-title')).toBeFocused();

  // From 640 px up, the language is in the header again.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('#studio-language')).toBeVisible();
  await expect(page.getByTestId('stop-ai-button')).toContainText('إيقاف');
});
