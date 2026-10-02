/**
 * Team and access end to end (board 22, A02, A09, A12): inviting and joining, changing a role,
 * suspending and removing someone safely, building a custom role with its diff and impact, and
 * the audit log with filters, integrity check and export. Keyboard, axe and phone widths too.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { auditPage, memberOf, overflowAt } from './access';
import { audit, Staff, seedWorkspace, tabTo, verifyEmail, type Workspace } from './support';

let workspace: Workspace;
let owner: Staff;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  workspace = await seedWorkspace();
  owner = workspace.staff;
});

test('HNV-22-01 HNV-22-02 · an invitation is sent from Studio and accepted from its link', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  await page.goto('/team');
  await expect(page.locator('h1')).toHaveText('Team and access');
  // Keyboard only: reach the invite button, open the dialog, fill it and send.
  await tabTo(page, page.getByTestId('invite-teammate'));
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('invite-dialog');
  await expect(dialog).toBeVisible();
  const invitee = await Staff.signUp('Bilal Agent', 'bilal');
  await dialog.getByLabel('Email address').fill(invitee.email);
  await dialog.getByLabel('Role', { exact: true }).selectOption({ label: 'Support agent' });
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(dialog.getByTestId('invite-sent')).toBeVisible();
  const link = (await dialog.locator('#invite-link').textContent()) ?? '';
  expect(link).toContain('/invitations/accept?token=');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('invite-teammate')).toBeFocused();
  await expect(page.locator(`[data-invitation="${invitee.email}"]`)).toContainText(
    'Invite pending',
  );

  await verifyEmail(invitee.email);
  const context = await browser.newContext();
  await invitee.signIn(context);
  const joiner = await context.newPage();
  await joiner.goto(new URL(link).pathname + new URL(link).search);
  await joiner.getByTestId('accept-invitation').click();
  await expect(joiner).toHaveURL(/\/overview/);
  await context.close();

  await page.reload();
  await expect(page.locator(`[data-member="${invitee.email}"]`)).toContainText('Support agent');
});

test('HNV-22-01 A02 · a role is changed in one step and a member is suspended and restored', async ({
  page,
}) => {
  const cai = await memberOf(owner, 'Cai Agent', 'cai', 'agent');
  await owner.signIn(page.context());
  await page.goto('/team');
  const row = page.locator(`[data-member="${cai.email}"]`);
  await row.getByTestId('member-actions').click();
  await page.getByRole('menuitem', { name: 'Change role or scope' }).click();
  const dialog = page.getByTestId('access-dialog');
  await dialog.getByRole('button', { name: 'Change', exact: true }).click();
  await dialog.getByLabel('Role', { exact: true }).selectOption({ label: 'Analyst' });
  await dialog.getByRole('button', { name: 'Save access' }).click();
  await expect(dialog.locator('[data-grant="analyst"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toContainText('Analyst');

  await row.getByTestId('member-actions').click();
  await page.getByRole('menuitem', { name: 'Suspend' }).click();
  await page.getByTestId('member-status-dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(row.locator('[data-status="suspended"]')).toBeVisible();
  await row.getByTestId('member-actions').click();
  await page.getByRole('menuitem', { name: 'Restore access' }).click();
  await page.getByTestId('member-status-dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(row.locator('[data-status="active"]')).toBeVisible();
});

test('HNV-22-05 · removing someone shows what they hold and protects the last owner', async ({
  page,
}) => {
  const dana = await memberOf(owner, 'Dana Agent', 'dana', 'agent');
  await owner.signIn(page.context());
  await page.goto('/team');
  // The only owner can't be removed: their own row offers nothing to change.
  const self = page.locator(`[data-member="${owner.email}"]`);
  await self.getByTestId('member-actions').click();
  await expect(page.getByText('You can’t change your own access here.')).toBeVisible();
  await page.keyboard.press('Escape');

  const row = page.locator(`[data-member="${dana.email}"]`);
  await row.getByTestId('member-actions').click();
  await page.getByRole('menuitem', { name: 'Remove from workspace' }).click();
  const dialog = page.getByTestId('offboard-dialog');
  await expect(dialog.getByTestId('open-conversations')).toHaveText(
    'They have no open conversations.',
  );
  await dialog.getByRole('textbox', { name: /^Reason/ }).fill('Left the company');
  await dialog.getByTestId('confirm-remove').click();
  await expect(page.getByTestId('members-notice')).toContainText(
    'was removed from this workspace.',
  );
  await expect(row).toHaveCount(0);
  // Her session ended with the removal (she had no other workspace).
  const me = await fetch(`${new URL(page.url()).origin}/v1/me`, {
    headers: { cookie: dana.cookie },
  });
  expect(me.status).toBe(401);
});

test('HNV-22-03 HNV-22-04 · a custom role shows its diff and impact before saving', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  await page.goto('/team?tab=roles');
  await page.getByTestId('new-role').click();
  let editor = page.getByTestId('role-editor');
  await editor.getByLabel('Name', { exact: true }).fill('Triage');
  await editor.getByLabel('Key', { exact: true }).fill('triage');
  await editor.getByLabel('Read conversations and customer history').check();
  await editor.getByLabel('Assign and transfer conversations').check();
  await expect(editor.getByTestId('preview-added')).toContainText(
    'Assign and transfer conversations',
  );
  await editor.getByTestId('save-role').click();
  await expect(page.getByTestId('roles-notice')).toHaveText('Role Triage was created.');
  const triage = page.locator('[data-role="triage"]');
  await expect(triage).toContainText('Permissions: 2');

  // Someone holds it; removing a permission shows who loses what.
  const eve = await memberOf(owner, 'Eve Triage', 'eve', 'triage');
  await page.reload();
  await triage.getByRole('button', { name: 'Open Triage' }).click();
  editor = page.getByTestId('role-editor');
  await editor.getByLabel('Assign and transfer conversations').uncheck();
  await editor.getByLabel('Export conversation transcripts').check();
  await expect(editor.getByTestId('preview-removed')).toContainText(
    'Assign and transfer conversations',
  );
  await expect(editor.getByTestId('preview-impact')).toContainText('Eve Triage');
  await expect(editor.getByTestId('preview-impact')).toContainText(
    'loses Assign and transfer conversations',
  );
  await expect(
    editor.getByText('Needs extra checks: Export conversation transcripts'),
  ).toBeVisible();
  await editor.getByTestId('save-role').click();
  await expect(page.getByTestId('roles-notice')).toHaveText('Role Triage was saved.');
  expect(eve.email).toContain('@');

  // Built-in roles are read only.
  await page.locator('[data-role="owner"]').getByRole('button', { name: 'Open Owner' }).click();
  editor = page.getByTestId('role-editor');
  await expect(
    editor.getByText(
      'Built-in roles can’t be changed. Duplicate one to make a custom role you can adjust.',
    ),
  ).toBeVisible();
  await expect(editor.getByTestId('save-role')).toHaveCount(0);
});

test('HNV-22-06 · the audit log filters, checks integrity and exports what it shows', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  await page.goto('/team?tab=audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await page.getByLabel('Action', { exact: true }).fill('member.removed');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByTestId('applied-filters')).toContainText('member.removed');
  const rows = page.getByTestId('audit-table').locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-action', 'member.removed');
  await expect(rows.first()).toContainText('Left the company');

  await page.getByTestId('verify-audit').click();
  await expect(page.getByTestId('audit-verification')).toHaveAttribute('data-ok', 'true');

  await page.getByTestId('export-audit').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export as CSV (spreadsheets)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^hamnivo-audit-tnt_[\w-]+-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe(
    'seq,id,occurred_at,actor_type,actor_id,action,target_type,target_id,outcome,reason,request_id,data,prev_hash,hash',
  );
  expect(csv).toContain(',member.removed,');
  expect(csv).not.toContain(',role.created,');
  await expect(page.getByTestId('audit-exported')).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows.first()).toHaveAttribute('data-action', 'audit.exported');
});

test('HNV-24-06 · team pages pass axe and fit a phone, in English and Arabic', async ({ page }) => {
  test.setTimeout(180_000);
  await owner.signIn(page.context());
  const violations: string[] = [];
  const overflow: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    for (const tab of ['members', 'roles', 'audit']) {
      violations.push(...(await auditPage(page, `/team?tab=${tab}`, locale, `team-${tab}`)));
      overflow.push(...(await overflowAt(page)));
    }
    await auditPage(page, '/team', locale, 'invite');
    await page.getByTestId('invite-teammate').click();
    await expect(page.getByTestId('invite-dialog')).toBeVisible();
    violations.push(...(await audit(page, `invite-dialog (${locale})`)));
    await page.keyboard.press('Escape');
    await page.goto(`/team?tab=roles&role=new&lang=${locale}`);
    await expect(page.getByTestId('role-editor')).toBeVisible();
    violations.push(...(await audit(page, `role-editor (${locale})`)));
  }
  expect(violations).toEqual([]);
  expect(overflow).toEqual([]);
});
