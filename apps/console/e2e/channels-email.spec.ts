/**
 * Settings → Channels → Connect email and Email settings (D13) in a real browser against the
 * gateway and the fake Chatwoot. The fake signs in to no real mailbox: it refuses the IMAP password
 * `wrong-password` the way Chatwoot does (422 "Error while connecting to the IMAP server"), which the
 * gateway names as the `imap.password` field. Covered: the four steps with axe on each, the refused
 * password taking the dialog back to step 2, connecting, editing the settings without sending a
 * password, Fix sign-in on a mailbox that needs attention (that status is answered by the test: the
 * stack cannot make the fake's mailbox ask to sign in again), and Arabic right to left on a phone.
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
  problem: string | null;
  aiAnswers: boolean;
  defaultTeamId: string | null;
}

const ADDRESS = 'help@gmail.com';

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

const isConnect = (request: Request) =>
  request.method() === 'POST' && request.url().endsWith('/channels/email');
const isSave = (request: Request) =>
  request.method() === 'PUT' && /\/v1\/admin\/channels\/[^/]+\/email$/.test(request.url());

test('Connect email · four steps, a refused password goes back to step 2, then it connects', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const empty = page.getByTestId('channels-empty');
  await expect(empty.getByRole('button', { name: 'Check for new channels' })).toBeVisible();
  await empty.getByRole('button', { name: 'Connect email' }).click();
  const dialog = page.getByTestId('connect-email-dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect email' })).toBeVisible();
  const step = dialog.getByTestId('email-step');
  const next = dialog.getByRole('button', { name: 'Next' });

  // Step 1: the address, the name in Studio, and Find my settings.
  await expect(step).toHaveText('Step 1 of 4');
  await expect(dialog.getByRole('heading', { name: 'Your address' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'How to connect email' })).toBeVisible();
  const address = dialog.getByLabel('Support address');
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute('dir', 'ltr');
  await expect(dialog.getByLabel('Name in Studio')).toHaveValue('Support email');
  const violations = await audit(page, 'connect email step 1 (en)');
  // Keyboard only: Enter goes to the next step, which first asks for the address.
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Enter an email address, like help@yourshop.com.')).toBeVisible();
  await expect(address).toBeFocused();
  await address.fill(ADDRESS);
  await dialog.getByRole('button', { name: 'Find my settings' }).click();
  await expect(dialog.getByTestId('channel-saved')).toHaveText(
    'We filled in the settings for Gmail / Google Workspace.',
  );
  const appPassword = dialog.getByTestId('app-password');
  await expect(appPassword).toContainText('Use an app password');
  await expect(appPassword).toContainText(
    'Your provider asks for an app password instead of your normal password.',
  );
  await expect(appPassword.getByRole('link')).toHaveAttribute(
    'href',
    'https://myaccount.google.com/apppasswords',
  );
  violations.push(...(await audit(page, 'connect email step 1, found (en)')));

  // Step 2: incoming mail, filled in; the password is typed hidden.
  await next.click();
  await expect(step).toHaveText('Step 2 of 4');
  await expect(dialog.getByRole('heading', { name: 'Incoming mail (IMAP)' })).toBeFocused();
  await expect(dialog.getByLabel('Incoming mail server')).toHaveValue('imap.gmail.com');
  await expect(dialog.getByLabel('Incoming port')).toHaveValue('993');
  await expect(dialog.getByRole('switch', { name: 'Use SSL' })).toBeChecked();
  await expect(dialog.getByLabel('Incoming login')).toHaveValue(ADDRESS);
  const password = dialog.getByLabel('Incoming password', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('wrong-password');
  violations.push(...(await audit(page, 'connect email step 2 (en)')));

  // Step 3: outgoing mail signs in like incoming mail unless unticked.
  await next.click();
  await expect(step).toHaveText('Step 3 of 4');
  await expect(dialog.getByLabel('Outgoing mail server')).toHaveValue('smtp.gmail.com');
  await expect(dialog.getByLabel('Outgoing port')).toHaveValue('587');
  await expect(dialog.getByLabel('Security')).toHaveValue('starttls');
  await expect(
    dialog.getByRole('checkbox', { name: 'Same login and password as incoming' }),
  ).toBeChecked();
  await expect(dialog.getByLabel('Outgoing password', { exact: true })).toHaveCount(0);
  violations.push(...(await audit(page, 'connect email step 3 (en)')));

  // Step 4: who answers.
  await next.click();
  await expect(step).toHaveText('Step 4 of 4');
  await expect(dialog.getByRole('switch', { name: 'AI answers here' })).not.toBeChecked();
  const team = dialog.getByRole('combobox', { name: 'Team' });
  await expect(team.locator('option')).toHaveText(['No team (use routing)', 'Billing']);
  await team.selectOption({ label: 'Billing' });
  violations.push(...(await audit(page, 'connect email step 4 (en)')));

  // Chatwoot refuses the password: back to step 2, the reason next to the password.
  let sent = page.waitForRequest(isConnect);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  expect((await sent).postDataJSON()).toEqual({
    name: 'Support email',
    address: ADDRESS,
    imap: {
      address: 'imap.gmail.com',
      port: 993,
      ssl: true,
      login: ADDRESS,
      password: 'wrong-password',
    },
    smtp: {
      address: 'smtp.gmail.com',
      port: 587,
      security: 'starttls',
      login: ADDRESS,
      password: 'wrong-password',
    },
    aiAnswers: false,
    defaultTeamId: billingTeamId,
  });
  await expect(step).toHaveText('Step 2 of 4');
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toHaveAccessibleDescription(/Error while connecting to the IMAP server/);
  await expect(dialog.getByTestId('action-error')).toBeVisible();
  violations.push(...(await audit(page, 'connect email refused (en)')));
  expect(await channels()).toEqual([]);

  await password.fill('right-password');
  await next.click();
  await next.click();
  sent = page.waitForRequest(isConnect);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    imap: { password: 'right-password' },
    smtp: { password: 'right-password' },
  });
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('channel-saved')).toHaveText(
    'Email connected. New emails will appear in your inbox.',
  );
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
    'Email connected. New emails will appear in your inbox.',
  );
  const mail = cardOf(page, 'Support email');
  await expect(mail.getByTestId('channel-kind')).toHaveText('Email');
  await expect(mail.getByTestId('channel-address')).toHaveText(ADDRESS);
  await expect(mail.getByTestId('channel-status')).toHaveText('Connected');
  await expect(mail.getByRole('combobox', { name: 'Team' })).toHaveValue(billingTeamId);
  // Focus is back on the page's Connect email button (the empty state is gone).
  await expect(page.getByTestId('connect-email')).toBeFocused();
  const [made] = await channels();
  expect(made).toMatchObject({
    kind: 'email',
    address: ADDRESS,
    brandId: workspace.brand.id,
    aiAnswers: false,
    defaultTeamId: billingTeamId,
  });
  // Nothing of the mailbox stays in the browser.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('password');
  violations.push(...(await audit(page, 'channels with email (en)')));
  expect(violations).toEqual([]);
});

test('Email settings · edited without sending a password', async ({ page, context }) => {
  await workspace.staff.signIn(context);
  await open(page);
  const mail = cardOf(page, 'Support email');
  await mail.getByRole('button', { name: 'Email settings for Support email' }).click();
  const dialog = page.getByTestId('email-settings-dialog');
  await expect(dialog.getByRole('heading', { name: 'Email settings' })).toBeVisible();
  await expect(dialog.getByLabel('Incoming mail server')).toHaveValue('imap.gmail.com');
  await expect(dialog.getByLabel('Outgoing mail server')).toHaveValue('smtp.gmail.com');
  await expect(dialog.getByLabel('Outgoing login')).toHaveValue(ADDRESS);
  await expect(dialog.getByLabel('Incoming password', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Change Incoming password' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Change Outgoing password' })).toBeVisible();
  const violations = await audit(page, 'email settings (en)');

  await dialog.getByLabel('Name in Studio').fill('Gmail support');
  await dialog.getByLabel('Outgoing port').fill('465');
  await dialog.getByLabel('Security').selectOption('tls');
  const sent = page.waitForRequest(isSave);
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await sent).postDataJSON()).toEqual({
    name: 'Gmail support',
    address: ADDRESS,
    imap: { address: 'imap.gmail.com', port: 993, ssl: true, login: ADDRESS },
    smtp: { address: 'smtp.gmail.com', port: 465, security: 'tls', login: ADDRESS },
  });
  await expect(dialog).toBeHidden();
  const renamed = cardOf(page, 'Gmail support');
  await expect(renamed.getByTestId('channel-saved')).toHaveText('Email settings saved.');
  await expect(
    renamed.getByRole('button', { name: 'Email settings for Gmail support' }),
  ).toBeFocused();

  // Chatwoot has the new settings.
  await renamed.getByRole('button', { name: 'Email settings for Gmail support' }).click();
  await expect(dialog.getByLabel('Outgoing port')).toHaveValue('465');
  await expect(dialog.getByLabel('Security')).toHaveValue('tls');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(violations).toEqual([]);
});

test('Email settings · Fix sign-in sends the new incoming password only', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  // The mailbox as Chatwoot reports it after a password change: it asks to sign in again.
  await page.route(`**/v1/admin/brands/${workspace.brand.id}/channels`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Channel[] };
    await route.fulfill({
      status: response.status(),
      json: {
        items: body.items.map((one) =>
          one.kind === 'email'
            ? { ...one, status: 'needs_attention', problem: 'Chatwoot asks to sign in again.' }
            : one,
        ),
      },
    });
  });
  await open(page);
  const mail = cardOf(page, 'Gmail support');
  await expect(mail.getByTestId('channel-status')).toHaveText('Needs attention');
  await expect(mail.getByTestId('channel-problem')).toHaveText(
    'Chatwoot says: Chatwoot asks to sign in again.',
  );
  await mail.getByRole('button', { name: 'Fix sign-in for Gmail support' }).click();
  const dialog = page.getByTestId('email-settings-dialog');
  const password = dialog.getByLabel('Incoming password', { exact: true });
  await expect(password).toBeFocused();
  await expect(password).toHaveValue('');
  await expect(dialog.getByTestId('fix-sign-in-hint')).toBeVisible();
  const violations = await audit(page, 'fix sign-in (en)');
  await password.fill('new-app-password');
  const sent = page.waitForRequest(isSave);
  await page.keyboard.press('Enter');
  const body = (await sent).postDataJSON() as {
    imap: Record<string, unknown>;
    smtp: Record<string, unknown>;
  };
  expect(body.imap.password).toBe('new-app-password');
  expect(body.smtp).not.toHaveProperty('password');
  await expect(dialog).toBeHidden();
  await expect(mail.getByTestId('channel-saved')).toHaveText('Email settings saved.');
  expect(violations).toEqual([]);
});

test('Connect email · Arabic, right to left, on a phone', async ({ page, context }) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const mail = cardOf(page, 'Gmail support');
  await expect(mail.getByRole('button', { name: 'إعدادات البريد لـ Gmail support' })).toBeVisible();
  await page.getByRole('button', { name: 'ربط البريد الإلكتروني' }).click();
  const dialog = page.getByTestId('connect-email-dialog');
  await expect(dialog.getByRole('heading', { name: 'ربط البريد الإلكتروني' })).toBeVisible();
  await expect(dialog.getByTestId('email-step')).toHaveText('الخطوة 1 من 4');
  await expect(dialog.getByRole('heading', { name: 'عنوانك' })).toBeVisible();
  const address = dialog.getByLabel('عنوان الدعم');
  await expect(address).toHaveAttribute('dir', 'ltr');
  await expect(dialog.getByLabel('الاسم في Studio')).toHaveValue('بريد الدعم');
  const violations = await audit(page, 'connect email step 1 (ar, phone)');
  await address.fill('desk@zoho.com');
  await dialog.getByRole('button', { name: 'اعثر على إعداداتي' }).click();
  await expect(dialog.getByTestId('channel-saved')).toHaveText(
    'ملأنا الإعدادات الخاصة بـ Zoho Mail.',
  );
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await expect(dialog.getByTestId('email-step')).toHaveText('الخطوة 2 من 4');
  await expect(dialog.getByLabel('خادم البريد الوارد')).toHaveValue('imap.zoho.com');
  await expect(dialog.getByLabel('خادم البريد الوارد')).toHaveAttribute('dir', 'ltr');
  await expect(dialog.getByLabel('منفذ البريد الوارد')).toHaveAttribute('dir', 'ltr');
  await expect(dialog.getByLabel('كلمة مرور البريد الوارد', { exact: true })).toHaveAttribute(
    'dir',
    'ltr',
  );
  violations.push(...(await audit(page, 'connect email step 2 (ar, phone)')));
  await dialog.getByLabel('كلمة مرور البريد الوارد', { exact: true }).fill('secret');
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await expect(dialog.getByLabel('الحماية')).toHaveValue('tls');
  violations.push(...(await audit(page, 'connect email step 3 (ar, phone)')));
  await dialog.getByRole('button', { name: 'التالي' }).click();
  await expect(dialog.getByRole('button', { name: 'ربط', exact: true })).toBeVisible();
  violations.push(...(await audit(page, 'connect email step 4 (ar, phone)')));
  violations.push(...(await overflowAt(page, [320, 390])));

  // Closing with what was typed asks first; discarding forgets it.
  await page.keyboard.press('Escape');
  const ask = page.getByTestId('discard-changes');
  await expect(ask).toBeVisible();
  violations.push(...(await audit(page, 'discard connect email (ar)')));
  await ask.getByRole('button', { name: /تجاهل/ }).click();
  await expect(dialog).toBeHidden();
  expect(await channels()).toHaveLength(1);
  expect(violations).toEqual([]);
});
