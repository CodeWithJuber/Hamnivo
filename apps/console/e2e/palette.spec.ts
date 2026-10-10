/**
 * HNV-03-05 · The command palette in a real browser: ⌘K / Ctrl+K or the header's Search button,
 * typing to narrow, the arrow keys and Enter to open a page, Esc to close with focus returned, in
 * English and Arabic, on a desktop and a phone, with no WCAG 2.2 AA violations axe can find.
 */
import { expect, type Page, test } from '@playwright/test';
import { memberOf } from './access';
import { audit, seedWorkspace } from './support';

const shots = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

test('HNV-03-05 · opens anywhere with the shortcut, narrows as you type, and Enter opens the page', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/overview');
  await expect(page.locator('h1').first()).toBeVisible();

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Go to a page' });
  await expect(palette).toBeVisible();
  const search = palette.getByRole('combobox');
  await expect(search).toBeFocused();
  expect(await audit(page, 'command palette (en)')).toEqual([]);
  await shot(page, 'palette-open-en');

  await search.fill('billing');
  await expect(palette.getByTestId('palette-item')).toHaveText(['Plan and billing']);
  await shot(page, 'palette-filtered-en');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/billing/);
  await expect(palette).toBeHidden();
  // As with the menu, the new page's heading has focus.
  await expect(page.locator('#page-title')).toBeFocused();

  // The arrow keys choose; a page behind a button is found too.
  await page.keyboard.press('Control+k');
  await search.fill('visitors');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/visitors/);

  // Esc closes it and gives focus back to the Search button that opened it.
  const button = page.getByRole('button', { name: 'Search pages' });
  await button.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(button).toBeFocused();
});

test('HNV-03-05 · lists only what the person may open, in Arabic, and fits a phone', async ({
  page,
  context,
  browser,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const agent = await memberOf(workspace.staff, 'Sami Agent', 'sami', 'agent');
  const agentContext = await browser.newContext();
  await agent.signIn(agentContext);
  const agentPage = await agentContext.newPage();
  await agentPage.goto('/inbox');
  await agentPage.getByRole('button', { name: 'Search pages' }).click();
  const list = agentPage.getByRole('dialog', { name: 'Go to a page' }).getByTestId('palette-item');
  await expect(list.first()).toBeVisible();
  const paths = await list.evaluateAll((items) => items.map((i) => i.getAttribute('data-path')));
  expect(paths).toContain('/inbox');
  expect(paths).not.toContain('/models');
  expect(paths).not.toContain('/stop-ai');
  expect(paths).not.toContain('/brands');
  await agentContext.close();

  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/overview?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('h1').first()).toBeVisible();
  await shot(page, 'header-phone-ar');
  await page.getByRole('button', { name: 'ابحث في الصفحات' }).click();
  const palette = page.getByRole('dialog', { name: 'انتقل إلى صفحة' });
  await expect(palette).toBeVisible();
  // The palette fits the phone's width.
  const box = await palette.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await palette.getByRole('combobox').fill('المعرفة');
  await expect(palette.getByTestId('palette-item').first()).toHaveAttribute(
    'data-path',
    '/knowledge',
  );
  expect(await audit(page, 'command palette (ar, phone)')).toEqual([]);
  await shot(page, 'palette-phone-ar');
  // English names work in Arabic too, for teams that mix languages.
  await palette.getByRole('combobox').fill('billing');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/billing/);
});
