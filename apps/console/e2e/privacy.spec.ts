/**
 * How long conversations are kept (A10, ADR 0017) in a real browser: an owner with two-step
 * verification chooses a period, sees how many conversations it would delete and the date deleting
 * starts, saves, and undoes it during the grace. English and Arabic, phone widths, axe audits.
 */
import { expect, test } from '@playwright/test';
import { auditPage, overflowAt, ownerWithMfa, signedInPage } from './access';
import type { Staff } from './support';

let owner: Staff;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  owner = (await ownerWithMfa('Hana Owner', 'privacy-owner')).staff;
});

test('an owner turns retention on, sees what goes and when, then undoes it', async ({
  context,
}) => {
  const page = await signedInPage(context, owner);
  await page.goto('/settings/privacy');
  await expect(page.locator('#page-title')).toHaveText('Privacy');
  const select = page.getByLabel('Keep resolved conversations');
  await expect(select).toHaveValue('forever');

  await select.selectOption('365');
  await expect(page.getByTestId('retention-preview')).toHaveText(
    'Resolved conversations older than this today: 0.',
  );
  await expect(page.getByTestId('retention-when')).toContainText('a week after you save');
  await page.getByTestId('retention-save').click();
  await expect(page.getByTestId('retention-pending')).toContainText(
    'resolved conversations older than 1 year will be deleted',
  );

  await page.getByTestId('retention-undo').click();
  await expect(page.getByTestId('retention-pending')).toHaveCount(0);
  await expect(select).toHaveValue('forever');
  const policy = await owner.call<{ conversationDays: number | null; version: number }>(
    'GET',
    '/v1/admin/privacy/retention',
  );
  expect(policy).toMatchObject({ conversationDays: null, version: 2 });
});

test('fits phones and passes axe in English and Arabic', async ({ context }) => {
  const page = await signedInPage(context, owner);
  for (const locale of ['en', 'ar'] as const) {
    expect(await auditPage(page, '/settings/privacy', locale, 'Privacy')).toEqual([]);
    expect(await overflowAt(page, [320, 390])).toEqual([]);
  }
});
