/**
 * Passkeys end to end (board 02, A13): register one on Account security, sign in with it, and use
 * it to confirm a sensitive action, with Chromium's virtual authenticator over CDP.
 */
import { expect, test } from '@playwright/test';
import { virtualAuthenticator } from './access';
import { ageSessions, seedWorkspace, type Workspace } from './support';

let workspace: Workspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace();
});

test('HNV-02-01 HNV-02-05 · a passkey is registered, signs in, and confirms a sensitive action', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { cdp, id } = await virtualAuthenticator(page);
  await workspace.staff.signIn(page.context());

  // Register.
  await page.goto('/account');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('status')).toHaveText(
    'Passkey added.',
  );
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId: id });
  expect(credentials).toHaveLength(1);
  expect(credentials[0]?.isResidentCredential).toBe(true);

  // Sign out, then sign in with the passkey alone.
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.locator('h1')).toHaveText('Overview');

  // A sensitive action with an old sign-in asks again; the passkey confirms it.
  await ageSessions(workspace.staff.email);
  await page.goto('/team?tab=roles&role=new');
  const editor = page.getByTestId('role-editor');
  await editor.getByLabel('Name', { exact: true }).fill('Passkey checked');
  await editor.getByLabel('Key', { exact: true }).fill('passkey_checked');
  await editor.getByLabel('Read conversations and customer history').check();
  await editor.getByTestId('save-role').click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toBeVisible();
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  await reauth.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(reauth).toBeHidden();
  await expect(page.getByTestId('roles-notice')).toHaveText('Role Passkey checked was created.');
  const signCount = (await cdp.send('WebAuthn.getCredentials', { authenticatorId: id }))
    .credentials[0]?.signCount;
  expect(signCount).toBeGreaterThanOrEqual(2);
});
