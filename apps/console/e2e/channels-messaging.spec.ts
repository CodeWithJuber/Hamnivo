/**
 * Settings → Channels → Connect WhatsApp, Meta set-up and Connect Telegram (D14) in a real browser
 * against the gateway and the fake Chatwoot. The fake asks no real Meta or Telegram: it refuses
 * WhatsApp access tokens starting with `bad-token` (422 "Provider config Invalid Credentials", which
 * the gateway names as the `accessToken` field) and Telegram tokens containing `bad-token`, and
 * makes up a bot name and a verify token the way Chatwoot gets them. Covered: the three steps of
 * Connect WhatsApp with axe on each, the refused token taking the dialog back to step 1, the
 * callback URL and verify token with Copy, Meta set-up from the card, Connect Telegram with the
 * bot's @name on its card, and Arabic right to left on a phone.
 *
 * Not covered here: the composer's WhatsApp reply window. Its states are covered by unit tests
 * (test/inbox-channels.test.tsx); whatsapp-templates.spec.ts opens a WhatsApp conversation made
 * through the stack's control port and sends a template after the 24 hours.
 */
import { expect, type Page, type Request, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, seedWorkspace, type Workspace } from './support';

interface Channel {
  id: string;
  brandId: string | null;
  kind: string;
  name: string;
  address: string | null;
  status: string;
  aiAnswers: boolean;
  defaultTeamId: string | null;
}

const NUMBER = '+971501234567';
const TOKEN = 'EAAG-permanent-system-user-token-e2e';
const BOT_TOKEN = '7654321:AAH-e2e-telegram-token-abcdefghij';

let workspace: Workspace;
let billingTeamId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
  const workspaces = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const team = await workspace.staff.call<{ id: string }>('POST', '/v1/admin/teams', {
    name: 'Billing',
    workspaceId: workspaces.items[0]?.id ?? null,
  });
  billingTeamId = team.id;
});

const channels = async () =>
  (
    await workspace.staff.call<{ items: Channel[] }>(
      'GET',
      `/v1/admin/brands/${workspace.brand.id}/channels`,
    )
  ).items;

async function open(page: Page, locale = 'en') {
  await page.goto(`/channels?brand=${workspace.brand.id}&lang=${locale}`);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const cardOf = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name }) });

const isConnect = (kind: 'whatsapp' | 'telegram') => (request: Request) =>
  request.method() === 'POST' && request.url().endsWith(`/channels/${kind}`);

test('Connect WhatsApp · a refused token goes back to step 1, then Meta’s webhook set-up', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const empty = page.getByTestId('channels-empty');
  await expect(empty).toContainText(
    'Connect your support email, a WhatsApp Business number or a Telegram bot here. Channels added in Chatwoot appear when you check for new channels.',
  );
  await expect(empty.getByRole('button', { name: 'Connect email' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await empty.getByRole('button', { name: 'Connect WhatsApp' }).click();
  const dialog = page.getByTestId('connect-whatsapp-dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect WhatsApp' })).toBeVisible();
  const step = dialog.getByTestId('whatsapp-step');

  // Step 1: the number, the ids and the token, with where to find them.
  await expect(step).toHaveText('Step 1 of 3');
  await expect(dialog.getByRole('heading', { name: 'Your number' })).toBeVisible();
  const help = dialog.getByTestId('whatsapp-help');
  await expect(help).toContainText(
    'Find these in Meta’s WhatsApp Manager → API setup. Use a permanent access token from a system user.',
  );
  await expect(help.getByRole('link')).toHaveAttribute(
    'href',
    'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  );
  await expect(dialog.getByLabel('Name in Studio')).toHaveValue('WhatsApp');
  const phone = dialog.getByLabel('Business phone number');
  await expect(phone).toHaveAttribute('dir', 'ltr');
  const violations = await audit(page, 'connect whatsapp step 1 (en)');

  // Keyboard only: Enter asks for what is missing and goes to the first of it.
  await phone.focus();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByText('Enter the number with + and the country code, like +971501234567.'),
  ).toBeVisible();
  await expect(phone).toBeFocused();
  violations.push(...(await audit(page, 'connect whatsapp step 1, missing (en)')));
  await phone.fill('+971 50 123 4567');
  await dialog.getByLabel('Phone number ID').fill('1098765');
  await dialog.getByLabel('WhatsApp Business Account ID').fill('2234567');
  const token = dialog.getByLabel('Access token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('bad-token-from-the-e2e-run');

  // Step 2: who answers.
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(step).toHaveText('Step 2 of 3');
  await expect(dialog.getByRole('heading', { name: 'Answering' })).toBeFocused();
  await expect(dialog.getByRole('switch', { name: 'AI answers here' })).not.toBeChecked();
  await dialog.getByRole('combobox', { name: 'Team' }).selectOption({ label: 'Billing' });
  violations.push(...(await audit(page, 'connect whatsapp step 2 (en)')));

  // Chatwoot (Meta) refuses the token: back to step 1, the reason next to the token.
  let sent = page.waitForRequest(isConnect('whatsapp'));
  await dialog.getByRole('button', { name: 'Connect' }).click();
  expect((await sent).postDataJSON()).toEqual({
    name: 'WhatsApp',
    phoneNumber: NUMBER,
    phoneNumberId: '1098765',
    businessAccountId: '2234567',
    accessToken: 'bad-token-from-the-e2e-run',
    aiAnswers: false,
    defaultTeamId: billingTeamId,
  });
  await expect(step).toHaveText('Step 1 of 3');
  await expect(token).toBeFocused();
  await expect(token).toHaveAttribute('aria-invalid', 'true');
  await expect(token).toHaveAccessibleDescription(/Invalid Credentials/);
  await expect(dialog.getByTestId('action-error')).toBeVisible();
  await expect(dialog.getByLabel('Phone number ID')).toHaveValue('1098765');
  violations.push(...(await audit(page, 'connect whatsapp refused (en)')));
  expect(await channels()).toEqual([]);

  await token.fill(TOKEN);
  await dialog.getByRole('button', { name: 'Next' }).click();
  sent = page.waitForRequest(isConnect('whatsapp'));
  await dialog.getByRole('button', { name: 'Connect' }).click();
  expect((await sent).postDataJSON()).toMatchObject({ accessToken: TOKEN });

  // Step 3: what to paste into Meta's webhook set-up, read-only, with Copy.
  await expect(step).toHaveText('Step 3 of 3');
  await expect(dialog.getByRole('heading', { name: 'Set up Meta’s webhook' })).toBeFocused();
  await expect(dialog.getByTestId('whatsapp-setup-steps')).toHaveText(
    'In Meta’s App Dashboard → WhatsApp → Configuration → Webhook, paste these, choose Verify and save, then subscribe to messages.',
  );
  const callback = dialog.getByLabel('Callback URL', { exact: true });
  await expect(callback).toHaveValue(/\/webhooks\/whatsapp\/\+971501234567$/);
  await expect(callback).toHaveAttribute('readonly', '');
  await expect(callback).toHaveAttribute('dir', 'ltr');
  const verify = dialog.getByLabel('Verify token', { exact: true });
  await expect(verify).toHaveValue(/^\S{8,}$/);
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(token).toHaveCount(0);
  violations.push(...(await audit(page, 'connect whatsapp set-up (en)')));

  await dialog.getByRole('button', { name: 'Copy Callback URL' }).click();
  await expect(dialog.getByTestId('whatsapp-connect-callback-copied')).toHaveText('Copied');
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await callback.inputValue(),
  );
  await dialog.getByRole('button', { name: 'Copy Verify token' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await verify.inputValue());
  const setup = await workspace.staff.call<{ callbackUrl: string; verifyToken: string }>(
    'GET',
    `/v1/admin/channels/${(await channels())[0]?.id}/whatsapp`,
  );
  expect(setup).toEqual({
    callbackUrl: await callback.inputValue(),
    verifyToken: await verify.inputValue(),
  });

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  const done = 'WhatsApp connected. Messages arrive in your inbox once Meta’s webhook is set up.';
  await expect(page.getByTestId('channel-saved')).toHaveText(done);
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(done);
  const card = cardOf(page, 'WhatsApp');
  await expect(card.getByTestId('channel-kind')).toHaveText('WhatsApp');
  await expect(card.getByTestId('channel-address')).toHaveText(NUMBER);
  await expect(card.getByRole('combobox', { name: 'Team' })).toHaveValue(billingTeamId);
  // Focus is back on the page's Connect WhatsApp button (the empty state is gone).
  await expect(page.getByTestId('connect-whatsapp')).toBeFocused();
  const [made] = await channels();
  expect(made).toMatchObject({
    kind: 'whatsapp',
    address: NUMBER,
    brandId: workspace.brand.id,
    defaultTeamId: billingTeamId,
  });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(TOKEN);
  violations.push(...(await audit(page, 'channels with whatsapp (en)')));
  expect(violations).toEqual([]);
});

test('Meta set-up · opened again from the WhatsApp card', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await workspace.staff.signIn(context);
  await open(page);
  const [wa] = await channels();
  const setup = await workspace.staff.call<{ callbackUrl: string; verifyToken: string }>(
    'GET',
    `/v1/admin/channels/${wa?.id}/whatsapp`,
  );
  const card = cardOf(page, 'WhatsApp');
  const button = card.getByRole('button', { name: 'Meta set-up for WhatsApp' });
  await button.click();
  const dialog = page.getByTestId('whatsapp-setup-dialog');
  await expect(dialog.getByRole('heading', { name: 'Set up Meta’s webhook' })).toBeVisible();
  await expect(dialog.getByLabel('Callback URL', { exact: true })).toHaveValue(setup.callbackUrl);
  await expect(dialog.getByLabel('Verify token', { exact: true })).toHaveValue(setup.verifyToken);
  const violations = await audit(page, 'meta set-up (en)');
  await dialog.getByRole('button', { name: 'Copy Verify token' }).click();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(setup.verifyToken);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  expect(violations).toEqual([]);
});

test('Connect Telegram · the token is checked, then the card shows the bot’s @name', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await open(page);
  await page.getByTestId('connect-telegram').click();
  const dialog = page.getByTestId('connect-telegram-dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect Telegram' })).toBeVisible();
  const help = dialog.getByTestId('telegram-help');
  await expect(help).toContainText(
    'Message @BotFather on Telegram, send /newbot and copy the token it gives you.',
  );
  await expect(help.getByRole('link')).toHaveAttribute(
    'href',
    'https://core.telegram.org/bots/features#botfather',
  );
  await expect(dialog.getByLabel('Name in Studio')).toHaveValue('Telegram');
  const token = dialog.getByLabel('Bot token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  const violations = await audit(page, 'connect telegram (en)');

  // Telegram (through Chatwoot) refuses the bot: the reason is next to the token.
  await token.fill('1234567:AAH-bad-token-abcdefghijklmnop');
  let sent = page.waitForRequest(isConnect('telegram'));
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await sent;
  await expect(token).toBeFocused();
  await expect(token).toHaveAttribute('aria-invalid', 'true');
  await expect(token).toHaveAccessibleDescription(/Bot token is invalid/);
  violations.push(...(await audit(page, 'connect telegram refused (en)')));

  await token.fill(BOT_TOKEN);
  await dialog.getByRole('switch', { name: 'AI answers here' }).click();
  sent = page.waitForRequest(isConnect('telegram'));
  // Keyboard only: Enter in the token field connects.
  await token.press('Enter');
  expect((await sent).postDataJSON()).toEqual({
    name: 'Telegram',
    botToken: BOT_TOKEN,
    aiAnswers: true,
    defaultTeamId: null,
  });
  await expect(dialog).toBeHidden();
  const card = cardOf(page, 'Telegram');
  await expect(card.getByTestId('channel-kind')).toHaveText('Telegram');
  const bot = (await channels()).find((one) => one.kind === 'telegram')?.address ?? '';
  expect(bot).toMatch(/^@\w+$/);
  await expect(card.getByTestId('channel-address')).toHaveText(bot);
  await expect(page.getByTestId('channel-saved')).toHaveText(
    `Telegram connected as ${bot}. New messages will appear in your inbox.`,
  );
  await expect(card.getByRole('switch', { name: 'AI answers here Telegram' })).toBeChecked();
  await expect(card.getByRole('button', { name: /Meta set-up/ })).toHaveCount(0);
  violations.push(...(await audit(page, 'channels with telegram (en)')));
  expect(violations).toEqual([]);
});

test('WhatsApp and Telegram · Arabic, right to left, on a phone', async ({ page, context }) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const wa = cardOf(page, 'WhatsApp');
  await expect(wa.getByTestId('channel-kind')).toHaveText('واتساب');
  await expect(wa.getByTestId('channel-address').locator('bdi')).toHaveAttribute('dir', 'ltr');

  // Meta set-up, in Arabic.
  await wa.getByRole('button', { name: 'إعداد Meta لـ WhatsApp' }).click();
  const setup = page.getByTestId('whatsapp-setup-dialog');
  await expect(setup.getByRole('heading', { name: 'إعداد Webhook لدى Meta' })).toBeVisible();
  const callback = setup.getByLabel('عنوان الاستدعاء (Callback URL)', { exact: true });
  await expect(callback).toHaveValue(/\/webhooks\/whatsapp\/\+971501234567$/);
  await expect(callback).toHaveAttribute('dir', 'ltr');
  await expect(
    setup.getByRole('button', { name: 'نسخ عنوان الاستدعاء (Callback URL)' }),
  ).toBeVisible();
  const violations = await audit(page, 'meta set-up (ar, phone)');
  violations.push(...(await overflowAt(page, [320, 390])));
  await page.setViewportSize({ width: 390, height: 844 });
  await setup.getByRole('button', { name: 'تم' }).click();
  await expect(setup).toBeHidden();

  // Connect WhatsApp, in Arabic: the numbers and the token read left to right.
  await page.getByTestId('connect-whatsapp').click();
  const dialog = page.getByTestId('connect-whatsapp-dialog');
  await expect(dialog.getByRole('heading', { name: 'ربط واتساب' })).toBeVisible();
  await expect(dialog.getByTestId('whatsapp-step')).toHaveText('الخطوة 1 من 3');
  await expect(dialog.getByRole('heading', { name: 'رقمك' })).toBeVisible();
  await expect(dialog.getByLabel('الاسم في Studio')).toHaveValue('واتساب');
  const phone = dialog.getByLabel('رقم هاتف النشاط التجاري');
  await expect(phone).toHaveAttribute('dir', 'ltr');
  await expect(dialog.getByLabel('رمز الوصول', { exact: true })).toHaveAttribute('dir', 'ltr');
  violations.push(...(await audit(page, 'connect whatsapp step 1 (ar, phone)')));
  await phone.fill('+966 55 123 4567');
  await dialog.getByLabel('معرّف رقم الهاتف (Phone number ID)').fill('3098765');
  await dialog
    .getByLabel('معرّف حساب واتساب للأعمال (WhatsApp Business Account ID)')
    .fill('4234567');
  await dialog.getByLabel('رمز الوصول', { exact: true }).fill(TOKEN);
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await expect(dialog.getByTestId('whatsapp-step')).toHaveText('الخطوة 2 من 3');
  await expect(dialog.getByRole('button', { name: 'ربط', exact: true })).toBeVisible();
  violations.push(...(await audit(page, 'connect whatsapp step 2 (ar, phone)')));
  violations.push(...(await overflowAt(page, [320, 390])));
  await page.setViewportSize({ width: 390, height: 844 });

  // Closing with what was typed asks first; discarding forgets it.
  await page.keyboard.press('Escape');
  const ask = page.getByTestId('discard-changes');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: /تجاهل/ }).click();
  await expect(dialog).toBeHidden();

  // Connect Telegram, in Arabic.
  await page.getByTestId('connect-telegram').click();
  const telegram = page.getByTestId('connect-telegram-dialog');
  await expect(telegram.getByRole('heading', { name: 'ربط تيليجرام' })).toBeVisible();
  await expect(telegram.getByLabel('الاسم في Studio')).toHaveValue('تيليجرام');
  await expect(telegram.getByLabel('رمز البوت', { exact: true })).toHaveAttribute('dir', 'ltr');
  violations.push(...(await audit(page, 'connect telegram (ar, phone)')));
  violations.push(...(await overflowAt(page, [320, 390])));
  await page.keyboard.press('Escape');
  await expect(telegram).toBeHidden();
  expect((await channels()).map((one) => one.kind).sort()).toEqual(['telegram', 'whatsapp']);
  expect(violations).toEqual([]);
});
