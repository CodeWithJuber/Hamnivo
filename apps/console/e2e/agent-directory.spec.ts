/**
 * HNV-11-01 · The agent directory in a real browser: what each agent is for, where it answers
 * (only the brand's default, published agent answers), the model customers get, and finding an
 * agent by typing or filtering, in English on a desktop and in Arabic on a phone.
 */
import { expect, type Page, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, seedWorkspace } from './support';

const shots = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

test('HNV-11-01 · each agent with its purpose, where it answers and its model; find one by typing', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.call('POST', '/v1/admin/agents', {
    brandId: workspace.brand.id,
    name: 'Returns helper',
    isDefault: false,
    config: {
      displayName: 'Returns assistant',
      purpose: 'Refunds and exchanges for online orders',
      model: { provider: 'mock', modelId: 'hamnivo-mock' },
    },
  });
  await workspace.staff.signIn(context);
  await page.goto('/agents');

  const table = page.getByTestId('agents-table');
  const live = table.locator(`[data-agent="${workspace.agent?.name}"]`);
  const helper = table.locator('[data-agent="Returns helper"]');
  await expect(live.locator('[data-answer]')).toHaveAttribute('data-answer', 'customers');
  await expect(live).toContainText(`Answers customers of ${workspace.brand.name}`);
  await expect(helper.locator('[data-answer]')).toHaveAttribute('data-answer', 'notLive');
  await expect(helper).toContainText('Refunds and exchanges for online orders');
  await shot(page, 'agents-directory');
  expect(await audit(page, 'agent directory (en)')).toEqual([]);

  const search = page.getByRole('searchbox', { name: 'Search agents' });
  await search.fill('refunds');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(page.getByTestId('agents-count')).toHaveText('Showing 1 of 2 agents.');
  await search.fill('no agent is called this');
  await expect(page.getByText('No agent matches these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(table.getByRole('row')).toHaveCount(3);
  await page.getByLabel('Show').selectOption('answering');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(live).toBeVisible();
});

test('HNV-11-01 · in Arabic on a phone the directory reads right to left and fits', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // On a phone each agent is a card, not a squeezed table.
  const card = page.getByTestId('agents-cards').locator(`[data-agent="${workspace.agent?.name}"]`);
  await expect(card).toContainText(`يجيب عملاء ${workspace.brand.name}`);
  await expect(page.getByTestId('agents-table')).toHaveCount(0);
  // The answer reads as a line of text, not a tall narrow column.
  const answer = await card.locator('[data-answer]').boundingBox();
  expect(answer?.width ?? 0).toBeGreaterThan(250);
  await shot(page, 'agents-directory-ar-390');
  expect(await audit(page, 'agent directory (ar, phone)')).toEqual([]);
  expect(await overflowAt(page, [320, 390])).toEqual([]);
  // Wider again, the table comes back.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.getByTestId('agents-table')).toBeVisible();
});
