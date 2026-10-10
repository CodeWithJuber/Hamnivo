/**
 * HNV-01-03 · HNV-01-04 · The guided setup's install step waits for the brand's website and turns
 * green by itself once a page there loads the chat; Home's checklist and the brand's row follow.
 * A page on the website is stood in for by the loader's own request (its launcher), sent with
 * the website's Origin header as a browser on that website would.
 */
import { expect, type Page, test } from '@playwright/test';
import { audit, SHOP, seedWorkspace, stack } from './support';

const shots = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

/** What the loader on a page of `origin` asks for before it shows the chat button. */
const pageLoadsChat = (widgetId: string, origin: string) =>
  fetch(`${stack().apiBase}/v1/widget/launcher?widgetId=${widgetId}`, { headers: { origin } });

test('HNV-01-04 · the install step turns green once a page of the website loads the chat', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  await workspace.staff.signIn(context);

  // Home lists the step, and it opens the guided setup at the install step.
  await page.goto('/overview');
  const step = page.getByTestId('setup-steps').locator('[data-step="install"]');
  await expect(step).toContainText('Put the chat on your website');
  const brandRow = page.locator(`[data-brand="${workspace.brand.name}"]`);
  await expect(brandRow.locator('[data-status="not-seen"]')).toHaveText('Not seen yet');
  await step.click();
  await expect(page).toHaveURL(/\/onboarding\?step=install/);

  const status = page.getByTestId('install-status');
  await expect(status).toHaveAttribute('data-state', 'waiting');
  await expect(status).toContainText('Waiting for your website');
  await shot(page, 'install-waiting');
  expect(await audit(page, 'install step, waiting')).toEqual([]);

  // A website the brand did not allow is refused, and changes nothing.
  expect((await pageLoadsChat(workspace.brand.widgetId, 'https://evil.example')).status).toBe(403);
  await page.getByTestId('install-check').click();
  await expect(status).toHaveAttribute('data-state', 'waiting');

  // A page on the brand's website loads the chat: the step sees it by itself, without a click.
  expect((await pageLoadsChat(workspace.brand.widgetId, SHOP)).status).toBe(200);
  await expect(status).toHaveAttribute('data-state', 'found', { timeout: 15_000 });
  await expect(status).toContainText('The chat is on your website');
  await expect(status).toContainText(SHOP);
  await shot(page, 'install-found');
  expect(await audit(page, 'install step, found')).toEqual([]);

  // Home: the step is done, and the brand's row says when the chat was last seen.
  await page.goto('/overview');
  await expect(brandRow.locator('[data-status="installed"]')).toBeVisible();
  await expect(page.locator('[data-step="install"]')).toHaveCount(0);
});

test('HNV-01-03 · in Arabic on a phone, the waiting state reads right to left and fits', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding?step=install&lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // The code reads left to right, as it is: `<script …` at the left, not reordered.
  const snippet = page.getByTestId('install-snippet');
  const code = await snippet.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(el.firstChild ?? el, 0);
    range.setEnd(el.firstChild ?? el, 1);
    const first = range.getBoundingClientRect();
    return { direction: style.direction, firstAtLeft: first.left - box.left < 4 };
  });
  expect(code).toEqual({ direction: 'ltr', firstAtLeft: true });
  await expect(snippet).toHaveText(/^<script/);

  const status = page.getByTestId('install-status');
  await expect(status).toContainText('بانتظار موقعك');
  await status.locator('summary').click();
  await expect(status).toContainText('سياسة أمان للمحتوى');
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(1);
  await shot(page, 'install-waiting-ar-390');
  expect(await audit(page, 'install step, Arabic phone')).toEqual([]);
});
