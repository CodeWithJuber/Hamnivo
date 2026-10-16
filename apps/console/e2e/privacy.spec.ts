/**
 * Settings → Privacy (A10) in a real browser:
 * - how long conversations are kept (ADR 0017): an owner with two-step verification chooses a
 *   period, sees how many conversations it would delete and the date deleting starts, saves, and
 *   undoes it during the grace;
 * - one customer's data (ADR 0018): the owner finds a visitor by their conversation's ID,
 *   downloads their data as a ZIP, then erases them after typing their ID.
 * English and Arabic, phone widths, axe audits.
 */
import { expect, test } from '@playwright/test';
import { auditPage, overflowAt, ownerWithMfa, signedInPage } from './access';
import { customerAsks, SHOP, type Staff } from './support';

let owner: Staff;
let widgetId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  owner = (await ownerWithMfa('Hana Owner', 'privacy-owner')).staff;
  const workspaces = await owner.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const brand = await owner.call<{ id: string; widgetId: string }>('POST', '/v1/admin/brands', {
    workspaceId: workspaces.items[0]?.id,
    name: 'Noor Books',
    allowedOrigins: [SHOP],
  });
  await owner.call('POST', '/v1/admin/authority/connections', { brandId: brand.id });
  widgetId = brand.widgetId;
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

test('an owner downloads a visitor’s data, then erases them everywhere', async ({ context }) => {
  test.setTimeout(120_000);
  const conversation = await customerAsks(widgetId, 'Hello, where is my order?');
  const page = await signedInPage(context, owner);
  await page.goto('/settings/privacy');
  await page.getByLabel('Find a customer').fill(conversation.id);
  await page.getByTestId('privacy-find').click();
  await page.getByTestId('privacy-customer').click();
  const card = page.getByTestId('privacy-customer-card');
  await expect(card).toContainText('Visitor without a name');
  const customerId = (await card.locator('code').textContent())?.trim() ?? '';
  expect(customerId).toMatch(/^cus_/);

  await card.getByTestId('privacy-export').click();
  await page.getByLabel('Reference (optional)').fill('Ticket 7');
  await page.getByTestId('privacy-export-dialog-submit').click();
  await expect(page.getByTestId('privacy-started')).toContainText('Preparing the file');
  const done = page.getByTestId('privacy-request').filter({ hasText: 'Ticket 7' });
  await expect(done).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    done.getByTestId('privacy-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`customer-${customerId}.zip`);

  await card.getByTestId('privacy-erase').click();
  await page.getByLabel(`Type the customer ID to confirm: ${customerId}`).fill(customerId);
  await page.getByTestId('privacy-erase-dialog-submit').click();
  await expect(page.getByTestId('privacy-started')).toContainText('Erasing has started');
  const erased = page.getByTestId('privacy-request').filter({ hasText: 'Erasure' });
  await expect(erased).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(erased).toContainText('Conversations deleted: 1 · Chatwoot contacts deleted: 1');
  await expect(owner.call('GET', `/v1/admin/privacy/customers/${customerId}`)).rejects.toThrow();
});

test('fits phones and passes axe in English and Arabic', async ({ context }) => {
  const page = await signedInPage(context, owner);
  for (const locale of ['en', 'ar'] as const) {
    expect(await auditPage(page, '/settings/privacy', locale, 'Privacy')).toEqual([]);
    expect(await overflowAt(page, [320, 390])).toEqual([]);
  }
});
