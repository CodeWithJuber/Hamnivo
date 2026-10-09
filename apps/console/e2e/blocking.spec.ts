/**
 * Blocking visitors (H20) in a real browser: from a chat's More actions (a reason, 24 hours, the
 * chat closed), the block on the Blocked page linked from the inbox, unblocking after a confirm,
 * and what an agent without `visitors.block` sees. English and Arabic, with axe audits.
 */
import { expect, type Page, test } from '@playwright/test';
import { memberOf, overflowAt } from './access';
import { audit, customerAsks, seedWorkspace, type Workspace } from './support';

interface Block {
  id: string;
  who: string;
  reason: string;
  active: boolean;
  conversationId: string | null;
  expiresAt: string | null;
}

let workspace: Workspace;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
});

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const blocks = (status: 'active' | 'all') =>
  workspace.staff.call<{ items: Block[] }>('GET', `/v1/visitors/blocks?status=${status}`);

test('H20 · block a visitor from a chat for 24 hours and close it, see them on Blocked, unblock after confirming', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const { id } = await customerAsks(workspace.brand.widgetId, 'You are all useless, answer me');
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${id}`);
  const pane = page.getByTestId('conversation-pane');
  await expect(pane).not.toHaveAttribute('data-status', 'resolved');
  const name = ((await page.getByTestId('conversation-title').textContent()) ?? '').trim();
  expect(name).not.toBe('');

  // More actions → Block visitor…
  await page.getByTestId('more-menu').click();
  await page.getByRole('menuitem', { name: 'Block visitor…' }).click();
  const dialog = page.getByTestId('block-dialog');
  await expect(dialog.getByRole('heading', { name: `Block ${name}` })).toBeVisible();
  await expect(dialog).toContainText(
    'They will see that chat isn’t available. Clearing their browser gets around a block; signed-in customers stay blocked on any device.',
  );
  const reason = dialog.getByRole('textbox', { name: 'Reason' });
  await expect(reason).toBeFocused();
  const howLong = dialog.getByRole('radiogroup', { name: 'How long' });
  for (const choice of ['24 hours', '7 days', '30 days', 'Until unblocked']) {
    await expect(howLong.getByRole('radio', { name: choice })).toBeVisible();
  }
  await expect(howLong.getByRole('radio', { name: '24 hours' })).toBeChecked();
  const closeChat = dialog.getByRole('checkbox', { name: 'Also close this chat' });
  await expect(closeChat).toBeChecked();

  // A reason is required: said on the field, and focus goes there.
  await dialog.getByRole('button', { name: 'Block visitor' }).click();
  await expect(dialog).toContainText('Write why you are blocking them.');
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  await expect(reason).toBeFocused();
  const violations = await audit(page, 'block dialog (en)');

  await reason.fill('Abusive messages to the team');
  await howLong.getByRole('radio', { name: '24 hours' }).check();
  await dialog.getByRole('button', { name: 'Block visitor' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
    `${name} is blocked, and the chat is closed.`,
  );
  // The chat closed with it, and shows so after a refresh.
  await expect(pane).toHaveAttribute('data-status', 'resolved');
  const [block] = (await blocks('active')).items;
  expect(block).toMatchObject({ reason: 'Abusive messages to the team', active: true });
  expect(block?.conversationId).toBe(id);
  const hours = (Date.parse(block?.expiresAt ?? '') - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23.5);
  expect(hours).toBeLessThanOrEqual(24);

  // The inbox links to the Blocked page next to Live visitors and Saved replies.
  await open(page, '/inbox');
  await page.getByTestId('blocked-link').click();
  await expect(page).toHaveURL(/\/blocked/);
  await expect(page.getByRole('heading', { level: 1, name: 'Blocked visitors' })).toBeVisible();
  const table = page.getByTestId('blocks-table');
  for (const column of ['Who', 'Reason', 'Blocked by', 'When', 'Expires']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }
  const row = table.getByTestId('block-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(block?.who ?? '');
  await expect(row).toContainText('Abusive messages to the team');
  await expect(row).toContainText('Sara Staff');
  await expect(row.getByRole('link', { name: `Open the chat with ${block?.who}` })).toHaveAttribute(
    'href',
    `/inbox/${id}`,
  );
  violations.push(...(await audit(page, 'blocked (en)')));

  // Right to left: the same page in Arabic, on a phone too.
  await open(page, '/blocked?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'الزوار المحظورون' })).toBeVisible();
  await expect(page.getByTestId('block-row')).toContainText('Abusive messages to the team');
  violations.push(...(await audit(page, 'blocked (ar)')));
  await page.getByTestId('unblock').click();
  const confirmAr = page.getByTestId('unblock-dialog');
  await expect(confirmAr).toContainText('يمكنهم بدء المراسلة من جديد فورًا.');
  violations.push(...(await audit(page, 'unblock dialog (ar)')));
  await confirmAr.getByRole('button', { name: 'إلغاء' }).click();
  await expect(confirmAr).toBeHidden();
  const overflowing = await overflowAt(page, [320, 390]);
  expect(overflowing).toEqual([]);

  // Unblocking asks first; cancelling keeps the block.
  await open(page, '/blocked?lang=en');
  await page.getByRole('button', { name: `Unblock ${block?.who}` }).click();
  const confirm = page.getByTestId('unblock-dialog');
  await expect(confirm.getByRole('heading', { name: `Unblock ${block?.who}?` })).toBeVisible();
  violations.push(...(await audit(page, 'unblock dialog (en)')));
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect((await blocks('active')).items).toHaveLength(1);
  await page.getByRole('button', { name: `Unblock ${block?.who}` }).click();
  await confirm.getByRole('button', { name: 'Unblock' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
    `${block?.who} is unblocked.`,
  );
  await expect(page.getByTestId('block-row')).toHaveCount(0);
  await expect(page.getByText('Nobody is blocked')).toBeVisible();
  expect((await blocks('active')).items).toHaveLength(0);

  // All (last 90 days) keeps it, marked as unblocked, in the link too.
  await page.getByRole('combobox', { name: 'Show' }).selectOption('all');
  await expect(page).toHaveURL(/status=all/);
  await expect(page.getByTestId('block-row')).toContainText('Unblocked by Sara Staff');
  await expect(page.getByTestId('unblock')).toHaveCount(0);
  violations.push(...(await audit(page, 'blocked, all (en)')));
  expect(violations).toEqual([]);
});

test('H20 · an agent cannot block: no menu entry, no Blocked link, and the page says why', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const agent = await memberOf(workspace.staff, 'Ali Agent', 'agent', 'agent');
  const { id } = await customerAsks(workspace.brand.widgetId, 'Is my parcel on the way?');
  const context = await browser.newContext();
  await agent.signIn(context);
  const page = await context.newPage();
  await open(page, `/inbox/${id}`);
  await page.getByTestId('more-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Make this a ticket' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Block visitor…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await open(page, '/inbox');
  await expect(page.getByTestId('live-visitors-link')).toBeVisible();
  await expect(page.getByTestId('blocked-link')).toHaveCount(0);
  await open(page, '/blocked');
  await expect(page.getByTestId('forbidden')).toContainText('You can’t see blocked visitors');
  expect(await audit(page, 'blocked, forbidden (en)')).toEqual([]);
  await context.close();
});
