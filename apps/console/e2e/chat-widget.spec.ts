/**
 * The Chat widget page (W03, W02, W26, W11, W27, W28) and tickets in the inbox (H19): set up by
 * keyboard, saved through the gateway, read back from it, and audited in English and Arabic.
 */
import { expect, type Page, test } from '@playwright/test';
import { audit, customerAsks, seedWorkspace, tabTo, type Workspace } from './support';

const LOCALES = ['en', 'ar'] as const;

interface FormsView {
  forms: {
    prechat: { enabled: boolean; fields: Array<{ id: string; kind: string; required: boolean }> };
    offline: { when: string; aiFirst: boolean };
  };
}

const widgetPage = (workspace: Workspace, tab: string, locale = 'en') =>
  `/chat-widget?brand=${workspace.brand.id}&tab=${tab}&lang=${locale}`;

async function ready(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test('W26 W11 · the questions before a chat and while nobody can answer, by keyboard', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto(widgetPage(workspace, 'forms'));
  await ready(page);
  const form = page.getByTestId('forms-form');

  // Turn the pre-chat form on and add a question, by keyboard alone.
  const enabled = form.getByRole('checkbox', { name: 'Ask these questions before a chat starts' });
  await tabTo(page, enabled);
  await page.keyboard.press('Space');
  await expect(enabled).toBeChecked();
  const add = page.getByTestId('prechat-fields').getByRole('button', { name: 'Add a question' });
  await add.focus();
  await page.keyboard.press('Enter');
  // Focus moves to the new question's kind: it asks for the email, as the name is asked already.
  const kind = page.locator('#prechat-field-email-kind');
  await expect(kind).toBeFocused();
  await kind.selectOption('choice');
  await page.locator('#prechat-field-email-label-en').fill('What is it about?');
  await page.locator('#prechat-field-email-option-option-label-en').fill('An order');
  await page.locator('#prechat-field-email-option-option-2-label-en').fill('A return');
  await page.getByRole('button', { name: 'Move What is it about? up' }).click();
  await expect(page.getByRole('button', { name: 'Move What is it about? down' })).toBeFocused();

  // The picture beside the form follows: the pre-chat form, as customers will see it.
  const preview = page.getByTestId('widget-preview');
  await expect(preview).toHaveAttribute('data-screen', 'prechat');
  await expect(preview.getByTestId('preview-field').first()).toContainText('What is it about?');
  // In the contact form, the email and the question cannot be dropped.
  await expect(page.getByRole('button', { name: 'Remove Your email' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await form.getByRole('radio', { name: 'Only when nobody on the team is online' }).check();
  expect(await audit(page, 'chat widget forms tab')).toEqual([]);
  await form.getByRole('button', { name: 'Save forms' }).click();
  await expect(page.getByTestId('forms-unsaved')).toBeHidden();

  const saved = await workspace.staff.call<FormsView>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/widget-forms`,
  );
  expect(saved.forms.prechat.enabled).toBe(true);
  expect(saved.forms.prechat.fields.map((field) => [field.id, field.kind])).toEqual([
    ['email', 'choice'],
    ['name', 'name'],
  ]);
  expect(saved.forms.offline.when).toBe('nobody_online');
});

test('W26 · what would be refused is said before anything is sent', async ({ page, context }) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto(widgetPage(workspace, 'forms'));
  await ready(page);
  await page.getByTestId('offline-fields').getByRole('button', { name: 'Add a question' }).click();
  await page.locator('#offline-field-phone-kind').selectOption('choice');
  await page.getByRole('button', { name: 'Save forms' }).click();
  const summary = page.locator('[data-slot="form-error-summary"]');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('Contact form, question 4: write answer 1 in English.');
  await summary.getByRole('link').first().click();
  await expect(page.locator('#offline-field-phone-option-option-label-en')).toBeFocused();
  expect(await audit(page, 'chat widget forms errors')).toEqual([]);
});

test('W27 · consent for visitors from the EU, EEA and UK, with the brand’s own words', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto(widgetPage(workspace, 'privacy'));
  await ready(page);
  const nobody = page.getByRole('radio', { name: 'Nobody' });
  await tabTo(page, nobody);
  // Arrow keys move between the choices and choose. The group chooses on focus while the key is
  // down, so each press is held for as long as a person's would be.
  await page.keyboard.press('ArrowDown', { delay: 50 });
  await page.keyboard.press('ArrowDown', { delay: 50 });
  await expect(
    page.getByRole('radio', { name: 'Only visitors from the EU, EEA and UK' }),
  ).toBeChecked();
  await page.locator('#consent-text-en').fill('We keep this chat so our team can help you.');
  await expect(page.getByTestId('consent-reconsent')).toBeVisible();
  await expect(page.getByTestId('preview-consent')).toHaveText(
    'We keep this chat so our team can help you.',
  );
  expect(await audit(page, 'chat widget privacy tab')).toEqual([]);
  await page.getByRole('button', { name: 'Save consent settings' }).click();
  await expect(page.getByTestId('consent-version')).toContainText('version 1');
  const saved = await workspace.staff.call<{ consent: unknown; noticeVersion: number }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/consent`,
  );
  expect(saved.consent).toEqual({
    mode: 'eu',
    text: { en: 'We keep this chat so our team can help you.' },
  });
  expect(saved.noticeVersion).toBe(1);
});

test('W28 · the direct link: on with Save, then a link to copy and open, and a QR code', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto(widgetPage(workspace, 'share'));
  await ready(page);
  await expect(page.getByTestId('direct-link-off')).toBeVisible();
  const enabled = page.getByRole('checkbox', { name: 'Let people open the chat from a link' });
  await tabTo(page, enabled);
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Save link setting' }).click();
  const url = page.getByRole('textbox', { name: 'Chat link' });
  await expect(url).toHaveValue(/^https?:\/\//);
  await expect(
    page.getByRole('img', { name: /QR code that opens the chat of Noor Books/ }),
  ).toBeVisible();
  const open = page.getByRole('link', { name: 'Open the chat link in a new tab' });
  await expect(open).toHaveAttribute('href', await url.inputValue());
  await expect(page.getByTestId('install-snippet')).toContainText(workspace.brand.widgetId);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download QR code' }).click();
  expect((await download).suggestedFilename()).toBe('chat-link-noor-books.svg');
  expect(await audit(page, 'chat widget share tab')).toEqual([]);
  const saved = await workspace.staff.call<{ enabled: boolean }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/direct-link`,
  );
  expect(saved.enabled).toBe(true);
});

test('W03 W26 W27 W28 · every tab reads right to left in Arabic and passes the audit', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  const violations: string[] = [];
  for (const locale of LOCALES) {
    for (const tab of ['look', 'behaviour', 'forms', 'privacy', 'share']) {
      await page.goto(widgetPage(workspace, tab, locale));
      await ready(page);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      if (tab !== 'share') {
        await expect(page.getByTestId('widget-preview')).toHaveAttribute(
          'dir',
          locale === 'ar' ? 'rtl' : 'ltr',
        );
      }
      violations.push(...(await audit(page, `chat widget ${tab} (${locale})`)));
    }
  }
  expect(violations).toEqual([]);
});

test('H19 · make a conversation a ticket, wait for the customer, and find it in Tickets', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const workspace = await seedWorkspace({ connect: true });
  const conversation = await customerAsks(workspace.brand.widgetId, 'My parcel has not arrived.');
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/inbox/${conversation.id}`);
  const pane = page.getByTestId('conversation-pane');
  await expect(pane).toBeVisible();

  const more = pane.getByRole('button', { name: 'More actions' });
  await tabTo(page, more);
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Make this a ticket' }).click();
  const dialog = page.getByTestId('make-ticket-dialog');
  await dialog.getByLabel(/Priority/).selectOption('high');
  expect(await audit(page, 'make ticket dialog')).toEqual([]);
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  await expect(dialog).toBeHidden();

  const bar = pane.getByTestId('ticket-bar');
  await expect(bar.getByRole('heading', { name: /Ticket #\d+/ })).toBeVisible();
  await expect(bar.getByLabel('Priority')).toHaveValue('high');
  await bar.getByRole('radio', { name: 'Pending' }).click();
  await expect(bar.getByRole('radio', { name: 'Pending' })).toHaveAttribute('aria-checked', 'true');
  expect(await audit(page, 'ticket bar')).toEqual([]);

  const queues = page.getByRole('navigation', { name: 'Queues' });
  await queues.getByRole('link', { name: /Tickets/ }).click();
  await expect(page).toHaveURL(/queue=tickets/);
  await page
    .getByRole('navigation', { name: 'Ticket state' })
    .getByRole('link', { name: 'Pending' })
    .click();
  await expect(page).toHaveURL(/ticketState=pending/);
  const row = page.getByTestId('inbox-row').first();
  await expect(row).toContainText('Waiting for the customer');
  await expect(row).toContainText('High priority');
  for (const locale of LOCALES) {
    await page.goto(`/inbox?queue=tickets&lang=${locale}`);
    await expect(page.getByTestId('ticket-filters')).toBeVisible();
    expect(await audit(page, `tickets queue (${locale})`)).toEqual([]);
  }
});
