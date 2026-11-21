/**
 * Studio's menu in a real browser: five entries, the pages of the current entry as a row of links
 * above the page, Stop AI as a header button, and the top of Home for the person's role. Frozen
 * features (orders, finance, migration, workflows, decisions, checks) are not listed: the test
 * server keeps HAMNIVO_ADVANCED_FEATURES at its default, off. The menu has no UX state ID of its
 * own; Home is HNV-03-01 and HNV-03-02.
 */
import { expect, test } from '@playwright/test';
import { memberOf, overflowAt } from './access';
import { seedWorkspace, tabTo } from './support';

const ENTRIES = ['Home', 'Inbox', 'AI assistant', 'Knowledge', 'Settings'];

test('the menu has five entries, and the pages of the current entry are a row of links above the page', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto(`/agents/${workspace.agent?.id}`);
  await expect(page.locator('h1').first()).toBeVisible();

  const menu = page.getByRole('navigation', { name: 'Studio', exact: true });
  await expect(menu.getByRole('link')).toHaveText(ENTRIES);
  // On one agent's page, the AI assistant entry is active, and so is "AI agents" in the row.
  await expect(menu.getByRole('link', { name: 'AI assistant' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
  const row = page.getByRole('navigation', { name: 'AI assistant pages' });
  await expect(row.getByRole('link')).toHaveCount(3);
  await row.getByText('Advanced settings', { exact: true }).click();
  await expect(row.getByRole('link')).toHaveCount(7);
  await expect(row.locator('[aria-current="page"]')).toHaveText('AI agents');
  // Frozen: not listed, even under Advanced settings.
  await expect(row.getByRole('link', { name: 'Decision rules' })).toHaveCount(0);

  // Stop AI is a red button in the header that leads to its page, not an entry in the menu.
  await expect(menu.getByRole('link', { name: 'Stop AI' })).toHaveCount(0);
  await expect(page.getByTestId('stop-ai-button')).toHaveAttribute('href', '/stop-ai');

  // The row works from the keyboard like any other links.
  await tabTo(page, row.getByRole('link', { name: 'Connectors' }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/connectors/);
  await expect(row.locator('[aria-current="page"]')).toHaveText('Connectors');
  await expect(menu.getByRole('link', { name: 'AI assistant' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Knowledge is an entry of its own.
  await menu.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(/\/knowledge/);
  await expect(menu.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Another entry has its own row, and stays active on each of its pages.
  await menu.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/brands/);
  const settingsSection = page.getByRole('navigation', { name: 'Settings pages' });
  await settingsSection.getByRole('link', { name: 'Channels', exact: true }).click();
  await expect(page).toHaveURL(/\/channels/);
  await settingsSection.getByText('Advanced settings', { exact: true }).click();
  await settingsSection.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(page).toHaveURL(/\/security/);
  await expect(settingsSection.locator('[aria-current="page"]')).toHaveText('Security');
  await expect(menu.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Orders and finance are frozen: not in the row, but their address still opens the page.
  await expect(settingsSection.getByRole('link', { name: 'Orders', exact: true })).toHaveCount(0);
  await page.goto('/orders');
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Reports sit under Home.
  await menu.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/overview/);
  const home = page.getByRole('navigation', { name: 'Home pages' });
  await home.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(menu.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  // A page that is its entry's only page has no row.
  await menu.getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByTestId('section-tabs')).toHaveCount(0);
});

test('on a phone the menu sheet has the same entries, and a long row of pages scrolls sideways', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/runs');

  // "Activity" is the last of the AI assistant's seven pages: the row starts with it in sight.
  const row = page.getByRole('navigation', { name: 'AI assistant pages' });
  const last = row.getByRole('link', { name: 'Activity' });
  await expect(last).toHaveAttribute('aria-current', 'page');
  await expect(last).toBeInViewport();
  expect(await overflowAt(page)).toEqual([]);
  // overflowAt leaves a desktop width behind.
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('navigation', { name: 'Studio', exact: true });
  await expect(menu.getByRole('link')).toHaveText(ENTRIES);
  await menu.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/brands/);
  // Following an entry closes the sheet, and the pages of Settings are on the page.
  await expect(menu).toBeHidden();
  const settings = page.getByRole('navigation', { name: 'Settings pages' });
  await expect(settings.locator('[aria-current="page"]')).toHaveText('Brands and install');
});

test('HNV-03-01 HNV-03-02 · Home starts with what is left to set up, or with the staff member’s chats', async ({
  page,
  context,
  browser,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/overview');

  // Brand and chat engine are done. No page of the website has loaded the chat yet. The published
  // agent answers with the offline practice model and there is no AI key yet, so those two are
  // still open; the owner has not invited anyone.
  const steps = page.getByTestId('setup-steps');
  await expect(steps.getByRole('link')).toHaveCount(4);
  await expect(steps).toContainText('Put the chat on your website');
  await expect(steps).toContainText('Add an AI key');
  await expect(steps).toContainText('Publish an AI agent');
  await expect(steps).toContainText('Invite a teammate');
  await expect(page.getByRole('heading', { name: 'Your chats' })).toHaveCount(0);
  await steps.getByRole('link', { name: 'Invite a teammate' }).click();
  await expect(page).toHaveURL(/\/team/);

  // An analyst reads conversations but neither manages brands nor sees the team: Home starts
  // with the chats, and a primary button into the inbox. It has no setup list.
  const analyst = await memberOf(workspace.staff, 'Ana Analyst', 'ana', 'analyst');
  const analystContext = await browser.newContext();
  await analyst.signIn(analystContext);
  const analystPage = await analystContext.newPage();
  await analystPage.goto('/overview');
  await expect(analystPage.getByRole('heading', { name: 'Your chats' })).toBeVisible();
  await expect(analystPage.getByTestId('chats-waiting')).toContainText('Waiting for a person');
  await expect(analystPage.getByTestId('chats-mine')).toContainText('Assigned to you');
  await expect(analystPage.getByTestId('setup-steps')).toHaveCount(0);
  await analystPage.getByRole('link', { name: 'Open inbox' }).click();
  await expect(analystPage).toHaveURL(/\/inbox/);
  await analystContext.close();
});
