/**
 * HNV-03-03 · HNV-03-04 · Home while it loads and when part of it fails, in a real browser. The
 * gateway's answers for one card are held back or failed with page.route; the rest of Home and
 * the inbox keep working.
 */
import { expect, type Page, test } from '@playwright/test';
import { audit, seedWorkspace } from './support';

const shots = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

test('HNV-03-04 · a failed card says so with its own retry; the rest of Home and the inbox work', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  let stopsDown = true;
  await page.route('**/v1/admin/kill-switches*', (route) =>
    stopsDown
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ status: 503, code: 'UNAVAILABLE', title: 'Unavailable' }),
        })
      : route.continue(),
  );
  await page.goto('/overview');

  const notice = page.getByTestId('overview-degraded');
  await expect(notice).toContainText('Part of Home couldn’t load', { timeout: 20_000 });
  const stops = page.getByRole('region', { name: 'AI stop switches' });
  await expect(stops.getByRole('button', { name: 'Try again' })).toBeVisible();
  // A 503 is named for what it is, not "something went wrong".
  await expect(stops).toContainText('A connected service isn’t responding');
  // The brands card is unaffected.
  await expect(page.getByRole('region', { name: 'Brands' })).toContainText(workspace.brand.name);
  await shot(page, 'overview-degraded');
  expect(await audit(page, 'Home, partly failed')).toEqual([]);

  // Retry brings the card back by itself, and the notice goes.
  stopsDown = false;
  await stops.getByRole('button', { name: 'Try again' }).click();
  await expect(stops).toContainText('The AI isn’t stopped anywhere.');
  await expect(notice).toBeHidden();

  // The way to the inbox works while Home is degraded.
  stopsDown = true;
  await page.reload();
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await notice.getByRole('link', { name: 'Open inbox' }).click();
  await expect(page).toHaveURL(/\/inbox/);
});

test('HNV-03-03 · while Home loads, each card holds its place with a placeholder in its shape', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The card fills from the brands or, failing that, the workspaces list: hold both.
  await page.route(/\/v1\/admin\/(brands|workspaces)$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/overview');
  const brands = page.getByRole('region', { name: 'Brands' });
  await expect(brands.getByTestId('brands-skeleton')).toBeVisible();
  await expect(brands.locator('[aria-busy="true"]')).toHaveCount(1);
  await expect(brands.getByRole('status')).toHaveText('Loading brands');
  const before = await brands.boundingBox();
  await shot(page, 'overview-loading');
  release();
  await expect(brands).toContainText(workspace.brand.name);
  const after = await brands.boundingBox();
  // The card keeps its shape: the placeholder is as wide as the rows and within a row of their
  // height. (Where the card sits can still move: Home's setup list above it appears only once its
  // own lists are in, so a finished workspace never flashes a checklist.)
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(2);
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(80);
});
