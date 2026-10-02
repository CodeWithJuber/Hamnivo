/**
 * A brand's chat settings and proactive prompts in Studio (W02, W09, W17, W19, W23, W25): saved
 * through the gateway, checked before saving, in English and Arabic, by keyboard, and audited.
 */
import { expect, test } from '@playwright/test';
import { audit, seedWorkspace, tabTo } from './support';

interface WidgetSettingsView {
  settings: {
    layout: { mode: string; position: string };
    attachments: {
      enabled: boolean;
      allowedTypes: string[];
      maxMegabytes: number;
      maxFiles: number;
    };
    help: { search: boolean; suggestions: Array<Record<string, string>> };
    deletion: { windowMinutes: number };
    notifications: { email: boolean };
  };
}

test('W02 W09 W17 W23 W25 · choose how the chat looks and what customers can do', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto('/brands');
  const open = page.getByRole('button', { name: 'Chat settings for Noor Books' });
  // By keyboard: to the button, open, and Escape returns focus to it.
  await tabTo(page, open);
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('chat-settings-dialog');
  await expect(dialog.getByRole('radio', { name: 'Floating button' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  await open.click();
  await dialog.getByRole('radio', { name: 'Side panel' }).click();
  await dialog.getByRole('combobox', { name: 'Button corner' }).selectOption('bottom-left');
  await dialog.getByRole('checkbox', { name: 'GIF pictures' }).click();
  // Checked before saving: the gateway would refuse files over 10 MB.
  await dialog.getByRole('textbox', { name: 'Largest file (MB)' }).fill('50');
  await dialog.getByRole('button', { name: 'Add a question' }).click();
  const question = dialog.getByRole('group', { name: 'Question 1' });
  await question.getByRole('textbox', { name: 'English' }).fill('Where is my order?');
  await question.getByRole('textbox', { name: 'Arabic' }).fill('أين طلبي؟');
  await dialog
    .getByRole('textbox', { name: 'Customers can delete a message for (minutes)' })
    .fill('5');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByText('Enter a whole number from 1 to 10.').first()).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Largest file (MB)' }).fill('5');
  expect(await audit(page, 'chat settings dialog')).toEqual([]);
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toBeHidden();

  const saved = await workspace.staff.call<WidgetSettingsView>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/widget-settings`,
  );
  expect(saved.settings).toMatchObject({
    layout: { mode: 'panel', position: 'bottom-left' },
    attachments: {
      enabled: true,
      allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
      maxMegabytes: 5,
    },
    help: { search: true, suggestions: [{ en: 'Where is my order?', ar: 'أين طلبي؟' }] },
    deletion: { windowMinutes: 5 },
    notifications: { email: true },
  });
});

test('W19 · proactive prompts: off by default, checked before saving, then on', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto('/brands');
  await page.getByRole('button', { name: 'Proactive prompts for Noor Books' }).click();
  const dialog = page.getByTestId('proactive-dialog');
  await expect(dialog.getByRole('checkbox', { name: 'Show proactive prompts' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Show proactive prompts' }).click();
  await dialog.getByRole('textbox', { name: 'Prompts one visitor sees in a day' }).fill('2');
  await dialog.getByRole('button', { name: 'Add a prompt' }).click();
  const prompt = dialog.getByRole('group', { name: 'Prompt 1' });
  await prompt.getByRole('textbox', { name: 'Name', exact: true }).fill('Pricing Help');
  await prompt.getByRole('textbox', { name: 'Page', exact: true }).fill('pricing');
  await dialog.getByRole('button', { name: 'Save prompts' }).click();
  await expect(
    dialog.getByText('Use lower-case letters, digits and dashes for prompt 1.').first(),
  ).toBeVisible();
  await expect(
    dialog.getByText('Start the page of prompt 1 with / and leave out ? and #.').first(),
  ).toBeVisible();
  await expect(dialog.getByText('Write the message of prompt 1 in English.').first()).toBeVisible();
  await prompt.getByRole('textbox', { name: 'Name', exact: true }).fill('pricing-help');
  await prompt.getByRole('textbox', { name: 'Page', exact: true }).fill('/pricing');
  await prompt
    .getByRole('group', { name: 'Message' })
    .getByRole('textbox', { name: 'English' })
    .fill('Questions about plans? Ask us.');
  expect(await audit(page, 'proactive dialog')).toEqual([]);
  await dialog.getByRole('button', { name: 'Save prompts' }).click();
  await expect(dialog).toBeHidden();
  const saved = await workspace.staff.call<{ settings: Record<string, unknown> }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/proactive`,
  );
  expect(saved.settings).toMatchObject({
    enabled: true,
    maxPerDay: 2,
    dismissHours: 24,
    triggers: [
      {
        id: 'pricing-help',
        kind: 'page_path',
        path: '/pricing',
        seconds: 5,
        message: { en: 'Questions about plans? Ask us.' },
      },
    ],
  });
});

test('W02 W19 · the settings read right to left in Arabic', async ({ page, context }) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto('/brands?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'إعدادات المحادثة لـ Noor Books' }).click();
  const dialog = page.getByTestId('chat-settings-dialog');
  await expect(dialog.getByRole('radio', { name: 'زر عائم' })).toBeChecked();
  expect(await audit(page, 'chat settings dialog (ar)')).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'الرسائل الاستباقية لـ Noor Books' }).click();
  await page.getByTestId('proactive-dialog').getByRole('button', { name: 'أضف رسالة' }).click();
  expect(await audit(page, 'proactive dialog (ar)')).toEqual([]);
});
