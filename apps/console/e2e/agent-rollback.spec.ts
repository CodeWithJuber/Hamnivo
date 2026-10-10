/**
 * HNV-11-06 · Rolling an agent back in a real browser: the version that was live before is
 * marked, the dialog says what changes for customers, a stale sign-in is confirmed first, the
 * earlier version is live again ("Live since" now), the draft is untouched and the audit log
 * records it as a rollback.
 */
import { expect, type Page, test } from '@playwright/test';
import { ageSessions, audit, PASSWORD, seedWorkspace } from './support';

const shots = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

test('HNV-11-06 · roll back to the version live before, after confirming it’s you', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const agentId = workspace.agent?.id ?? '';
  // Version 2 goes live over version 1.
  const detail = await workspace.staff.call<{
    published: { config: Record<string, unknown> };
  }>('GET', `/v1/admin/agents/${agentId}`);
  await workspace.staff.call('PUT', `/v1/admin/agents/${agentId}/draft`, {
    config: { ...detail.published.config, displayName: 'Noor helper v2' },
  });
  await workspace.staff.call('POST', `/v1/admin/agents/${agentId}/publish`, {});

  await workspace.staff.signIn(context);
  await page.goto(`/agents/${agentId}`);
  const versions = page.getByTestId('versions');
  const v1 = versions.locator('[data-version="1"]');
  const v2 = versions.locator('[data-version="2"]');
  await expect(v2).toHaveAttribute('data-state', 'published');
  await expect(v2).toContainText('Live since');
  await expect(v1).toContainText('Live before this one');
  await expect(versions.getByTestId('versions-stop-ai')).toHaveAttribute('href', '/stop-ai');
  await shot(page, 'rollback-versions');
  expect(await audit(page, 'agent versions')).toEqual([]);

  // The sign-in is an hour old: rolling back asks to confirm it first, then carries on.
  await ageSessions(workspace.staff.email);
  await v1.getByRole('button', { name: 'Roll back to version 1' }).click();
  const dialog = page.getByTestId('rollback-dialog');
  await expect(dialog).toContainText(
    'Customers get version 1 again from their next message, and version 2 stops answering.',
  );
  await expect(dialog).toContainText('recorded in the audit log');
  await shot(page, 'rollback-dialog');
  await dialog.getByRole('button', { name: 'Roll back' }).click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  await reauth.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();

  await expect(dialog).toBeHidden();
  await expect(v1).toHaveAttribute('data-state', 'published');
  await expect(v1).toContainText('Live since');
  await expect(v2).toHaveAttribute('data-state', 'retired');
  // Version 2 is now the one live before, one click away if the rollback was wrong.
  await expect(v2).toContainText('Live before this one');
  await expect(v2.getByRole('button', { name: 'Roll back to version 2' })).toBeVisible();

  // The audit log records it as a rollback, with the version.
  const events = await workspace.staff.call<{
    items: Array<{ action: string; data: { version?: number; rollback?: boolean } }>;
  }>('GET', '/v1/admin/audit?action=agent.published');
  expect(events.items.map((e) => [e.data.version, e.data.rollback])).toContainEqual([1, true]);
});
