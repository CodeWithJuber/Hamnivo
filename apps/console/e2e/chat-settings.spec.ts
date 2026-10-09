/**
 * A brand's chat settings in Studio (W02, W09, W17, W23, W25): saved
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
  // By keyboard: the brand's card leads to its Chat widget page, and the Behaviour tab.
  const open = page.getByRole('link', { name: 'Chat widget settings for Noor Books' });
  await tabTo(page, open);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/chat-widget\\?brand=${workspace.brand.id}`));
  await page.getByRole('tab', { name: 'Behaviour' }).click();
  await expect(page).toHaveURL(/tab=behaviour/);
  const form = page.getByTestId('chat-settings-form');
  await expect(form.getByRole('radio', { name: 'Floating button' })).toBeChecked();

  await form.getByRole('radio', { name: 'Side panel' }).click();
  await form.getByRole('combobox', { name: 'Button corner' }).selectOption('bottom-left');
  await form.getByRole('checkbox', { name: 'GIF pictures' }).click();
  // Checked before saving: the gateway would refuse files over 10 MB.
  await form.getByRole('textbox', { name: 'Largest file (MB)' }).fill('50');
  await form.getByRole('button', { name: 'Add a question' }).click();
  const question = form.getByRole('group', { name: 'Question 1' });
  await question.getByRole('textbox', { name: 'English' }).fill('Where is my order?');
  await question.getByRole('textbox', { name: 'Arabic' }).fill('أين طلبي؟');
  // The picture beside the form offers the question before the customer writes.
  await expect(page.getByTestId('preview-suggestions')).toContainText('Where is my order?');
  await form
    .getByRole('textbox', { name: 'Customers can delete a message for (minutes)' })
    .fill('5');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form.getByText('Enter a whole number from 1 to 10.').first()).toBeVisible();
  await form.getByRole('textbox', { name: 'Largest file (MB)' }).fill('5');
  expect(await audit(page, 'chat widget behaviour tab')).toEqual([]);
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form.getByTestId('behaviour-unsaved')).toBeHidden();

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

test('W02 · the settings read right to left in Arabic', async ({ page, context }) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto(`/chat-widget?brand=${workspace.brand.id}&tab=behaviour&lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const form = page.getByTestId('chat-settings-form');
  await expect(form.getByRole('radio', { name: 'زر عائم' })).toBeChecked();
  expect(await audit(page, 'chat widget behaviour tab (ar)')).toEqual([]);
});
