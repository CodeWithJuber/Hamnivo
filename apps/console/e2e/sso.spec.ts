/**
 * Single sign-on end to end (A13, boards 02 and 26): an owner proves the domain with DNS, connects
 * the stack's OpenID Connect provider and turns it on; a new person signs in through the provider
 * and joins with the chosen role; "SSO only" then turns passwords away for the domain.
 */
import { randomBytes } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  auditPage,
  inviteByApi,
  overflowAt,
  ownerWithMfa,
  publishTxt,
  virtualAuthenticator,
} from './access';
import { ageSessions, audit, PASSWORD, type Staff, stack, verifyEmail } from './support';

const domain = `sso-${randomBytes(3).toString('hex')}.example`;
let owner: Staff;
let tenantName: string;
/** Omar's browser, whose virtual authenticator holds the passkey he added before SSO was required. */
let omarBrowser: { context: BrowserContext; page: Page } | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const created = await ownerWithMfa('Nadia Owner', 'sso-owner');
  owner = created.staff;
  tenantName = created.tenant.name;
  // Someone at the domain who already has a password (before SSO is required).
  const response = await fetch(`${stack().apiBase}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: stack().studioUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Omar Local', email: `omar@${domain}`, password: PASSWORD }),
  });
  expect(response.ok).toBe(true);
  // Confirmed, as following the link in the confirmation email would: only a confirmed account
  // is ever linked to a single sign-on identity.
  await verifyEmail(`omar@${domain}`);
});

/** Signs in at the stack's identity provider (its login form takes any password). */
async function atProvider(page: Page, email: string) {
  await expect(page).toHaveURL(new RegExp(`^${stack().idp.issuer}/`));
  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill('any password');
  await page.locator('button[type="submit"]').click();
}

test('A13 · an owner proves the domain, connects the provider and turns SSO on', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  await page.goto('/security');
  await expect(page.locator('h1')).toHaveText('Security');
  await page.getByLabel('Domain', { exact: true }).fill(domain);
  await page.getByTestId('add-domain').click();
  const card = page.locator(`[data-domain="${domain}"]`);
  await expect(card).toHaveAttribute('data-status', 'pending');
  const name = (await card.locator('code').nth(0).textContent()) ?? '';
  const value = (await card.locator('code').nth(1).textContent()) ?? '';
  expect(name).toBe(`_hamnivo-verification.${domain}`);

  // Not published yet: the check says so.
  await card.getByTestId('verify-domain').click();
  await expect(card.getByTestId('domain-check')).toHaveAttribute('data-result', 'not_found');
  publishTxt(name, value);
  await card.getByTestId('verify-domain').click();
  await expect(card).toHaveAttribute('data-status', 'verified');

  // Connect the identity provider; the secret goes in and never comes back.
  const form = page.getByTestId('connect-form');
  await form.getByLabel('Issuer URL').fill(stack().idp.issuer);
  await form.getByLabel('Client ID').fill(stack().idp.clientId);
  await form.getByLabel('Client secret').fill(stack().idp.clientSecret);
  await form.getByTestId('save-connection').click();
  const connection = page.getByTestId('sso-connection');
  await expect(connection).toHaveAttribute('data-status', 'draft');
  await expect(connection.getByTestId('secret-masked')).toHaveText(
    `••••${stack().idp.clientSecret.slice(-4)}`,
  );
  expect(await page.content()).not.toContain(stack().idp.clientSecret);
  await expect(connection.locator('code').first()).toContainText('/api/auth/sso/callback/ssoc_');

  await connection.getByTestId('turn-on-sso').click();
  await expect(connection).toHaveAttribute('data-status', 'active');
  await connection.getByLabel('New people who sign in with single sign-on').selectOption({
    label: 'Support agent',
  });
  await connection.getByTestId('save-jit').click();
  await expect(connection.getByTestId('sso-notice')).toHaveText(
    'New people now join as Support agent.',
  );
});

test('HNV-02-01 A13 · a new person signs in with SSO and joins with the chosen role', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByTestId('continue-with-sso').click();
  await page.getByLabel('Work email address').fill(`lina@${domain}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await atProvider(page, `lina@${domain}`);
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByText(tenantName).first()).toBeVisible();
  // The agent role: the inbox is in the menu, Team and access is read-only, Security is not.
  await expect(page.getByRole('link', { name: 'Inbox' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Security', exact: true })).toHaveCount(0);
  await context.close();
});

test('A13 · an address the provider has not verified is turned away', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByTestId('continue-with-sso').click();
  await page.getByLabel('Work email address').fill(`unverified.mona@${domain}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await atProvider(page, `unverified.mona@${domain}`);
  await expect(page).toHaveURL(/\/sign-in\?error=sso_email_unverified/);
  await expect(page.getByTestId('sso-error')).toHaveText(
    'Your identity provider hasn’t verified your email address.',
  );
  await context.close();
});

test('A13 · someone at the domain joins with a password and adds a passkey, before SSO is required', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const token = await inviteByApi(owner, `omar@${domain}`, 'agent');
  const context = await browser.newContext();
  const page = await context.newPage();
  await virtualAuthenticator(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(`omar@${domain}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.goto(`/invitations/accept?token=${encodeURIComponent(token)}`);
  await page.getByTestId('accept-invitation').click();
  await expect(page).toHaveURL(/\/overview/);
  await page.goto('/account');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('status')).toHaveText(
    'Passkey added.',
  );
  omarBrowser = { context, page };
});

test('HNV-02-01 A13 · with SSO required, a password sign-in is turned to SSO', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  await page.goto('/security');
  const connection = page.getByTestId('sso-connection');
  await connection.getByTestId('sso-only').click();
  await expect(connection.getByTestId('sso-notice')).toHaveText(
    `Single sign-on is now required for ${domain}.`,
  );

  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto('/sign-in');
  await visitor.getByLabel('Email address').fill(`omar@${domain}`);
  await visitor.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await visitor.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    visitor
      .getByRole('main')
      .getByText('Your organization requires single sign-on for this address.'),
  ).toBeVisible();
  await visitor.getByTestId('sso-required-continue').click();
  await expect(visitor.getByLabel('Work email address')).toHaveValue(`omar@${domain}`);
  await visitor.getByRole('button', { name: 'Continue', exact: true }).click();
  await atProvider(visitor, `omar@${domain}`);
  await expect(visitor).toHaveURL(/\/(overview|tenants)/);
  await context.close();
});

test('A13 · with SSO required, a passkey is turned away too', async () => {
  if (!omarBrowser) throw new Error('Omar has no passkey browser');
  const { context, page } = omarBrowser;
  await context.clearCookies();
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(
    page.getByRole('main').getByText('Your organization requires single sign-on for this address.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
  // Refused before any session was created.
  expect((await context.cookies()).filter((c) => c.name.includes('session_token'))).toEqual([]);
  await context.close();
  omarBrowser = null;
});

test('HNV-02-05 · after SSO, a sensitive action is confirmed at the provider, which asks again', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // New people now join as auditors, who may export the audit log: an action that needs a recent
  // sign-in but no two-step verification.
  const role = await owner.call<{ id: string }>('POST', '/v1/admin/roles', {
    key: 'sso_auditor',
    name: 'SSO auditor',
    permissions: ['members.read', 'audit.read', 'audit.export'],
  });
  const { connections } = await owner.call<{
    connections: Array<{ id: string; version: number }>;
  }>('GET', '/v1/admin/sso');
  const connection = connections[0];
  if (!connection) throw new Error('no SSO connection');
  await owner.call('PATCH', `/v1/admin/sso/connections/${connection.id}`, {
    version: connection.version,
    jitRoleId: role.id,
  });

  const email = `rami@${domain}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByTestId('continue-with-sso').click();
  await page.getByLabel('Work email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await atProvider(page, email);
  await expect(page).toHaveURL(/\/overview/);

  // An hour later, exporting asks to sign in again. The provider still has a session, but it
  // checks who this is again (prompt=login) before the export goes ahead.
  await ageSessions(email);
  await page.goto('/team?tab=audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await page.getByTestId('export-audit').click();
  await page.getByRole('menuitem', { name: 'Export as CSV (spreadsheets)' }).click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  // Single sign-on comes first for someone who signed in that way.
  await expect(reauth).toContainText('Continue with your organization’s single sign-on.');
  await expect(reauth.getByRole('button').first()).toHaveText('Use single sign-on');
  const downloaded = page.waitForEvent('download');
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    reauth.getByTestId('reauth-sso').click(),
  ]);
  await atProvider(popup, email);
  await expect(reauth).toBeHidden();
  expect((await downloaded).suggestedFilename()).toMatch(/\.csv$/);
  await expect(page.getByTestId('audit-exported')).toBeVisible();
  await context.close();
});

test('HNV-24-06 · the security page passes axe and fits a phone, in English and Arabic', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await owner.signIn(page.context());
  const violations: string[] = [];
  for (const locale of ['en', 'ar'] as const) {
    violations.push(...(await auditPage(page, '/security', locale, 'security')));
    expect(await overflowAt(page)).toEqual([]);
  }
  const visitor = await page.context().browser()?.newContext();
  if (visitor) {
    const signIn = await visitor.newPage();
    for (const locale of ['en', 'ar'] as const) {
      await signIn.goto(`/sign-in?lang=${locale}`);
      await signIn.getByTestId('continue-with-sso').click();
      await expect(signIn.getByTestId('sso-form')).toBeVisible();
      violations.push(...(await audit(signIn, `sso-form (${locale})`)));
    }
    await visitor.close();
  }
  expect(violations).toEqual([]);
});
