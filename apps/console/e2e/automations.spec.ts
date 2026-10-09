/**
 * Automations in Studio (G21): a rule made from a template, its condition edited while "Try it"
 * follows, published, a version restored, turned off and deleted, all through the gateway; the
 * warnings the gateway would refuse to publish; and the pages audited in English and Arabic.
 */
import { expect, type Page, test } from '@playwright/test';
import { audit, seedWorkspace, type Workspace } from './support';

interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  draft: {
    event: { type: string; seconds: number };
    conditions: Array<{ field: string; op: string; value: unknown }>;
  };
  published: { version: number; publishedByName: string | null } | null;
}

const listPage = (workspace: Workspace, locale = 'en') =>
  `/automations?brand=${workspace.brand.id}&lang=${locale}`;

async function ready(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const automationOf = (workspace: Workspace, id: string) =>
  workspace.staff.call<AutomationView>('GET', `/v1/admin/automations/${id}`);

test('G21 · from a template to a published rule, a restored version, off and deleted', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Brands and install leads here; with no rule yet, the templates are on the page.
  await page.goto('/brands');
  await page.getByRole('link', { name: 'Automations for Noor Books' }).click();
  await expect(page).toHaveURL(/\/automations\?brand=/);
  await ready(page);
  const gallery = page.getByTestId('template-gallery');
  await expect(gallery.getByTestId('template')).toHaveCount(6);
  expect(await audit(page, 'automations, empty')).toEqual([]);

  // A template becomes a draft, and the editor opens on it.
  await gallery.getByRole('button', { name: 'Use the template Help on the pricing page' }).click();
  await expect(page).toHaveURL(/\/automations\/aut_/);
  await ready(page);
  const id = page.url().split('/automations/')[1]?.split('?')[0] ?? '';
  await expect(page.locator('h1')).toHaveText('Help on the pricing page');
  await expect(page.getByTestId('automation-status-line')).toContainText('Not published yet');
  await expect(page.locator('#automation-seconds')).toHaveValue('30');

  // Try it: the sample page is not the pricing page, so the rule would not run.
  const tryIt = page.getByTestId('try-it');
  await expect(tryIt.getByTestId('try-result')).toHaveAttribute('data-matched', 'false');
  await expect(tryIt.getByTestId('try-verdict')).toHaveAttribute('data-result', 'false');
  await expect(tryIt.getByTestId('try-bubble')).toHaveText(
    'Questions about our plans? Ask us here.',
  );
  // Changing the condition changes the verdict, with the same check the gateway makes.
  await page.locator('#condition-c0-value').fill('example.com');
  await expect(tryIt.getByTestId('try-verdict')).toHaveAttribute('data-result', 'true');
  await expect(tryIt.getByTestId('try-result')).toHaveAttribute('data-matched', 'true');
  await expect(tryIt.getByTestId('try-result')).toHaveText('This rule would run.');
  // A fact left unknown counts as not true.
  await tryIt.locator('#try-page_url').fill('');
  await expect(tryIt.getByTestId('try-verdict')).toHaveAttribute('data-result', 'null');
  await tryIt.locator('#try-page_url').fill('https://example.com/pricing');
  await expect(tryIt.getByTestId('try-result')).toHaveAttribute('data-matched', 'true');
  // The preview follows the visitor's language, right to left in Arabic.
  await tryIt.locator('#try-language').selectOption('ar');
  await expect(tryIt.getByTestId('try-bubble')).toHaveAttribute('dir', 'rtl');
  await expect(tryIt.getByTestId('try-bubble')).toHaveText('لديك أسئلة عن خططنا؟ اسألنا هنا.');
  expect(await audit(page, 'automation editor')).toEqual([]);

  // Publish saves the changes first, then publishes them as version 1.
  await expect(page.getByTestId('automation-unsaved')).toBeVisible();
  await page.getByTestId('publish-automation').click();
  await expect(page.getByTestId('automation-status-line')).toContainText(
    'Version 1, published by Sara Staff',
  );
  await expect(page.getByTestId('automation-unsaved')).toBeHidden();
  let saved = await automationOf(workspace, id);
  expect(saved.published?.version).toBe(1);
  expect(saved.draft.conditions).toEqual([
    { field: 'page_url', op: 'contains', value: 'example.com' },
  ]);

  // A second version waits longer.
  await page.locator('#automation-seconds').fill('45');
  await page.getByTestId('publish-automation').click();
  await expect(page.getByTestId('automation-status-line')).toContainText('Version 2');
  await expect(page.getByTestId('automation-version')).toHaveCount(2);

  // Restoring version 1 copies it into the draft; what runs stays version 2 until published.
  await page.getByRole('button', { name: 'Restore version 1' }).click();
  const restore = page.getByTestId('restore-version-dialog');
  await restore.getByRole('button', { name: 'Restore to draft' }).click();
  await expect(restore).toBeHidden();
  await expect(page.locator('#automation-seconds')).toHaveValue('30');
  await expect(page.getByTestId('automation-status-line')).toContainText(
    'The draft has changes that are not published yet.',
  );
  saved = await automationOf(workspace, id);
  expect(saved.draft.event.seconds).toBe(30);
  expect(saved.published?.version).toBe(2);

  // Back on the list: the rule in words, where it stands, and its switch.
  await page.getByRole('link', { name: 'All automations' }).click();
  await ready(page);
  const row = page.getByTestId('automation-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('automation-summary')).toHaveText(
    'When a visitor has been on a page for 30 sec, if the page address contains example.com → show a prompt',
  );
  await expect(row.getByTestId('automation-status')).toHaveText(
    'Published v2 · unpublished changes',
  );
  await expect(row.getByTestId('automation-activity')).toHaveText('Runs in visitors’ browsers');
  const toggle = row.getByRole('switch', { name: 'Run Help on the pricing page' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(row.getByTestId('automation-status')).toHaveText('Off');
  expect((await automationOf(workspace, id)).enabled).toBe(false);
  expect(await audit(page, 'automations list')).toEqual([]);

  // Duplicate, then delete the original.
  await row.getByRole('button', { name: 'Duplicate Help on the pricing page' }).click();
  await expect(page.getByTestId('automation-row')).toHaveCount(2);
  await expect(
    page.getByRole('heading', { name: 'Help on the pricing page (copy)' }),
  ).toBeVisible();
  await page
    .getByTestId('automation-row')
    .first()
    .getByRole('button', { name: 'Delete Help on the pricing page' })
    .click();
  const confirm = page.getByTestId('delete-automation-dialog');
  await confirm.getByRole('button', { name: 'Delete automation' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('automation-row')).toHaveCount(1);
  const list = await workspace.staff.call<{ items: AutomationView[] }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/automations`,
  );
  expect(list.items.map((item) => item.name)).toEqual(['Help on the pricing page (copy)']);
});

test('G21 · a chat message that could interrupt the AI is flagged before publishing', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(listPage(workspace));
  await ready(page);
  await page
    .getByTestId('template-gallery')
    .getByRole('button', { name: 'Use the template Welcome reply' })
    .click();
  await expect(page).toHaveURL(/\/automations\/aut_/);
  await ready(page);
  await expect(page.getByTestId('automation-warning')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove condition 1' }).click();
  await expect(page.getByTestId('automation-warning').first()).toContainText(
    'The AI is answering this chat. A message from this rule would interrupt it',
  );
  await page.getByTestId('publish-automation').click();
  const summary = page.locator('[data-slot="form-error-summary"]');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('add ‘Who has the chat is not the AI’');
  await summary.getByRole('link').first().click();
  await expect(page.locator('#action-a0-type')).toBeFocused();
  expect(await audit(page, 'automation editor warnings')).toEqual([]);
});

test('G21 · the pages read right to left in Arabic and pass the audit', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  const created = await workspace.staff.call<AutomationView>(
    'POST',
    `/v1/admin/brands/${workspace.brand.id}/automations`,
    {
      name: 'Chat rescue',
      definition: {
        event: { type: 'customer_waiting', seconds: 90 },
        match: 'all',
        conditions: [{ field: 'owner', op: 'is_not', value: ['ai'] }],
        actions: [
          {
            type: 'send_message',
            message: { en: 'Sorry for the wait.', ar: 'نعتذر عن الانتظار.' },
          },
          { type: 'set_priority', priority: 'high' },
        ],
      },
    },
  );
  const violations: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(listPage(workspace, locale));
      await ready(page);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      violations.push(...(await audit(page, `automations list (${locale}, ${width})`)));
      await page.goto(`/automations/${created.id}?lang=${locale}`);
      await ready(page);
      await expect(page.getByTestId('automation-editor')).toBeVisible();
      if (width < 1024) {
        // On phones, Try it opens under the form.
        await page.getByTestId('try-it').locator('summary').click();
      }
      await expect(page.getByTestId('try-it').getByTestId('try-result')).toBeVisible();
      violations.push(...(await audit(page, `automation editor (${locale}, ${width})`)));
      const extra = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (extra > 1) violations.push(`editor (${locale}, ${width}) is ${extra}px too wide`);
    }
  }
  // The gallery dialog, over a list that already has a rule.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(listPage(workspace, 'ar'));
  await ready(page);
  await page.getByTestId('new-automation').click();
  await expect(page.getByTestId('template-dialog')).toBeVisible();
  violations.push(...(await audit(page, 'template dialog (ar)')));
  expect(violations).toEqual([]);
});
