/**
 * The platform console and support access end to end (A17, A18, board 26): an operator asks a
 * workspace for temporary access, its owner approves it narrower, both sides see it, the operator
 * reads only what was approved and ends it; an incident banner reaches every workspace.
 */
import { expect, test } from '@playwright/test';
import { appointOperator, auditPage, enableTotp, overflowAt, ownerWithMfa } from './access';
import { audit, Staff } from './support';

let owner: Staff;
let tenantName: string;
let operator: Staff;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const created = await ownerWithMfa('Nora Owner', 'plat-owner');
  owner = created.staff;
  tenantName = created.tenant.name;
  const signedUp = await Staff.signUp('Pat Operator', 'pat-operator');
  operator = (await enableTotp(signedUp)).staff;
  await appointOperator(operator.email, 'platform_admin');
});

test('HNV-26-01 A17 · the console is for platform operators only, and shows service health', async ({
  page,
  browser,
}) => {
  await owner.signIn(page.context());
  await page.goto('/overview');
  await expect(page.locator('h1')).toHaveText('Overview');
  // Owning a workspace gives no platform access: no link, and the console says so.
  await expect(page.getByTestId('platform-link')).toHaveCount(0);
  await page.goto('/platform');
  await expect(page.getByTestId('not-operator')).toBeVisible();

  const context = await browser.newContext();
  await operator.signIn(context);
  const operatorPage = await context.newPage();
  await operatorPage.goto('/platform?view=health');
  const health = operatorPage.getByTestId('platform-health');
  await expect(health.locator('[data-service="database"]')).toContainText('Healthy');
  await expect(health.locator('[data-service="api"]')).toContainText('Healthy');
  await context.close();
});

test('HNV-26-02 HNV-26-03 HNV-26-04 · from tenant metadata, an operator asks for access and the owner approves it narrower', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await operator.signIn(page.context());
  await page.goto('/platform');
  await expect(page.getByTestId('platform-console')).toBeVisible();
  await page.getByLabel('Search tenants').fill(tenantName);
  await page.getByRole('button', { name: 'Search tenants' }).click();
  await page.getByRole('link', { name: `Open ${tenantName}` }).click();
  const detail = page.getByTestId('tenant-detail');
  await expect(detail).toContainText('No access to customer content');
  // Metadata only: no member addresses here.
  await expect(detail).not.toContainText(owner.email);
  await detail.getByTestId('request-access').click();
  const dialog = page.getByTestId('request-access-dialog');
  await dialog.getByLabel('Reason').fill('The widget stopped answering customers this morning.');
  await dialog.getByLabel('Conversation list (status only, never messages)').check();
  await dialog.getByTestId('send-access-request').click();
  await expect(dialog).toBeHidden();

  const context = await browser.newContext();
  await owner.signIn(context);
  const ownerPage = await context.newPage();
  await ownerPage.goto('/overview');
  await expect(ownerPage.getByTestId('support-pending-banner')).toBeVisible();
  await ownerPage.getByRole('link', { name: 'Review the request' }).click();
  await expect(ownerPage).toHaveURL(/\/security/);
  const request = ownerPage.getByTestId('support-request');
  await expect(request).toContainText('Pat Operator, Hamnivo support');
  await request.getByLabel('Conversation list (status only, never messages)').uncheck();
  await request.getByTestId('approve-support').click();
  await expect(ownerPage.getByTestId('support-active')).toBeVisible();
  await expect(ownerPage.getByTestId('support-banner')).toContainText('Pat Operator');
  await context.close();

  await page.goto('/platform?view=support');
  const grant = page.getByTestId('my-support-grant').first();
  await expect(grant).toHaveAttribute('data-state', 'active');
  await expect(grant.getByTestId('read-conversations')).toHaveCount(0);
  await grant.getByTestId('read-configuration').click();
  await expect(page.getByTestId('support-configuration')).toContainText(owner.email);
  await grant.getByTestId('end-support').click();
  await expect(page.getByTestId('my-support-grant').first()).toHaveAttribute('data-state', 'ended');
  // What was read through it is gone from the page.
  await expect(page.getByTestId('support-configuration')).toHaveCount(0);
  await expect(page.getByText(owner.email)).toHaveCount(0);
});

test('HNV-26-06 · an incident banner reaches every workspace until resolved', async ({
  page,
  browser,
}) => {
  await operator.signIn(page.context());
  await page.goto('/platform?view=incidents');
  await page.getByTestId('declare-incident').click();
  const dialog = page.getByTestId('declare-incident-dialog');
  await dialog.getByLabel('Title').fill('Slow AI replies');
  await dialog
    .getByLabel('Message for workspaces')
    .fill('AI replies are slow. People still get answers.');
  await dialog.getByTestId('post-incident').click();
  await expect(page.locator('[data-incident-status="active"]')).toContainText('Slow AI replies');

  const context = await browser.newContext();
  await owner.signIn(context);
  const ownerPage = await context.newPage();
  await ownerPage.goto('/overview');
  await expect(ownerPage.getByTestId('incident-banner')).toContainText('Slow AI replies');

  await page.getByTestId('resolve-incident').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('[data-incident-status="resolved"]')).toContainText('Slow AI replies');
  await ownerPage.reload();
  await expect(ownerPage.locator('h1')).toHaveText('Overview');
  await expect(ownerPage.getByTestId('incident-banner')).toHaveCount(0);
  await context.close();
});

test('HNV-24-06 · the platform console passes axe and fits a phone, in English and Arabic', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await operator.signIn(page.context());
  const violations: string[] = [];
  const overflow: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    for (const view of ['tenants', 'health', 'support', 'incidents', 'audit']) {
      violations.push(
        ...(await auditPage(page, `/platform?view=${view}`, locale, `platform-${view}`)),
      );
      overflow.push(...(await overflowAt(page)));
    }
  }
  await page.goto('/platform?view=incidents');
  await page.getByTestId('declare-incident').click();
  violations.push(...(await audit(page, 'declare-incident-dialog')));
  expect(violations).toEqual([]);
  expect(overflow).toEqual([]);
});
