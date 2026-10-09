/**
 * Blocking visitors (H20) in a real browser: from a chat's More actions (a reason, 24 hours, the
 * chat closed), the block on the Blocked page linked from the inbox, unblocking after a confirm,
 * and what an agent without `visitors.block` sees. English and Arabic, with axe audits.
 *
 * Senders on email, WhatsApp and Telegram: a customer's channel message can only be made inside
 * the stack's own process (the fake Chatwoot's receiveChannelMessage), so the test answers for the
 * gateway there: a web chat is shown as a WhatsApp conversation, and the Blocked page lists
 * channel blocks as the gateway words them. Blocking itself still goes to the gateway.
 */
import { expect, type Page, test } from '@playwright/test';
import { memberOf, overflowAt } from './access';
import { audit, customerAsks, seedWorkspace, type Workspace } from './support';

/** The name Studio shows for a block, in English. */
const nameOf = (block: { name: string | null; code: string } | undefined) =>
  block ? (block.name ?? `Visitor ${block.code}`) : '';

interface Block {
  id: string;
  brandId: string;
  name: string | null;
  code: string;
  channel: { kind: string; address: string | null } | null;
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
  await expect(row).toContainText(nameOf(block));
  await expect(row).toContainText('Abusive messages to the team');
  await expect(row).toContainText('Sara Staff');
  await expect(
    row.getByRole('link', { name: `Open the chat with ${nameOf(block)}` }),
  ).toHaveAttribute('href', `/inbox/${id}`);
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
  await page.getByRole('button', { name: `Unblock ${nameOf(block)}` }).click();
  const confirm = page.getByTestId('unblock-dialog');
  await expect(confirm.getByRole('heading', { name: `Unblock ${nameOf(block)}?` })).toBeVisible();
  violations.push(...(await audit(page, 'unblock dialog (en)')));
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect((await blocks('active')).items).toHaveLength(1);
  await page.getByRole('button', { name: `Unblock ${nameOf(block)}` }).click();
  await confirm.getByRole('button', { name: 'Unblock' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
    `${nameOf(block)} is unblocked.`,
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

test('H20 · a WhatsApp sender is blocked as a sender: their messages still arrive, closed unanswered', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const { id } = await customerAsks(workspace.brand.widgetId, 'Buy followers now, cheap!!!');
  await workspace.staff.signIn(context);
  // The conversation as the gateway shows a WhatsApp one.
  await page.route(`**/v1/inbox/conversations/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ status: response.status(), json: { ...body, channel: 'whatsapp' } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${id}`);
  const name = ((await page.getByTestId('conversation-title').textContent()) ?? '').trim();

  await page.getByTestId('more-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Block visitor…' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Block sender…' }).click();
  const dialog = page.getByTestId('block-dialog');
  await expect(dialog.getByRole('heading', { name: `Block ${name}` })).toBeVisible();
  await expect(dialog).toContainText(
    'Their messages will still arrive, but each conversation is closed automatically, without an answer. They are not told. The block covers this address on this channel only.',
  );
  await expect(dialog).not.toContainText('browser');
  const closeChat = dialog.getByRole('checkbox', { name: 'Also close this conversation' });
  await expect(closeChat).toBeChecked();
  const violations = await audit(page, 'block sender dialog (en)');

  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Spam on WhatsApp');
  await dialog.getByRole('button', { name: 'Block sender' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
    `${name} is blocked, and the conversation is closed.`,
  );
  const blocked = (await blocks('active')).items.find((one) => one.conversationId === id);
  expect(blocked).toMatchObject({ reason: 'Spam on WhatsApp', active: true });

  // Right to left: the same dialog in Arabic, on a phone.
  await open(page, `/inbox/${id}?lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('more-menu').click();
  await page.getByRole('menuitem', { name: 'حظر المُرسِل…' }).click();
  await expect(dialog).toContainText('يشمل الحظر هذا العنوان على هذه القناة فقط.');
  await expect(dialog.getByRole('button', { name: 'احظر المُرسِل' })).toBeVisible();
  violations.push(...(await audit(page, 'block sender dialog (ar)')));
  await dialog.getByRole('button', { name: 'إلغاء' }).click();
  await expect(dialog).toBeHidden();
  expect(violations).toEqual([]);
});

test('H20 · the Blocked page names senders by their address and channel', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await workspace.staff.signIn(context);
  const at = new Date().toISOString();
  const sender = (id: string, channel: Block['channel'], name: string | null = null) => ({
    id,
    brandId: workspace.brand.id,
    name,
    code: id.slice(-4).toUpperCase(),
    signedIn: false,
    channel,
    customerId: null,
    visitorId: null,
    conversationId: null,
    reason: 'Spam',
    createdBy: null,
    createdAt: at,
    expiresAt: null,
    liftedAt: null,
    liftedBy: null,
    active: true,
  });
  // The list as the gateway sends it, with three channel senders added.
  await page.route('**/v1/visitors/blocks?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Block[] };
    await route.fulfill({
      status: response.status(),
      json: {
        items: [
          sender('blk_e2email', { kind: 'email', address: 'amina@customer.example' }),
          sender('blk_e2ewhat', { kind: 'whatsapp', address: '+971501234567' }, 'Omar Khan'),
          sender('blk_e2etele', { kind: 'telegram', address: null }),
          ...body.items,
        ],
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/blocked?lang=en');
  const email = page.locator('[data-block-id="blk_e2email"]');
  await expect(email.getByTestId('block-sender')).toHaveText('amina@customer.example on Email');
  await expect(email.getByTestId('block-sender').locator('bdi')).toHaveAttribute('dir', 'ltr');
  await expect(
    email.getByRole('button', { name: 'Unblock amina@customer.example on Email' }),
  ).toBeVisible();
  // A name, when the sender gave one, stays the main label.
  const whatsapp = page.locator('[data-block-id="blk_e2ewhat"]');
  await expect(whatsapp).toContainText('Omar Khan');
  await expect(whatsapp.getByTestId('block-sender')).toHaveText('+971501234567 on WhatsApp');
  await expect(whatsapp.getByRole('button', { name: 'Unblock Omar Khan' })).toBeVisible();
  const telegram = page.locator('[data-block-id="blk_e2etele"]');
  await expect(telegram.getByTestId('block-sender')).toHaveText('Telegram sender');
  await expect(telegram.getByTestId('block-sender')).toHaveAttribute('data-channel', 'telegram');
  const violations = await audit(page, 'blocked senders (en)');

  // Right to left, on a phone too: the address keeps its own direction.
  await open(page, '/blocked?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(whatsapp.getByTestId('block-sender')).toHaveText('+971501234567 على واتساب');
  await expect(telegram.getByTestId('block-sender')).toHaveText('مُرسِل على تيليجرام');
  violations.push(...(await audit(page, 'blocked senders (ar)')));
  violations.push(...(await overflowAt(page, [320, 390])));
  expect(violations).toEqual([]);
});
