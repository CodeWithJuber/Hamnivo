/**
 * Single sign-on end to end (A13, boards 02 and 26): an owner proves the domain with DNS, connects
 * the stack's OpenID Connect provider and turns it on; a new person signs in through the provider
 * and joins with the chosen role; "SSO only" then turns passwords away for the domain.
 */
import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { auditPage, overflowAt, ownerWithMfa, publishTxt } from './access';
import { audit, PASSWORD, type Staff, stack, verifyEmail } from './support';

const domain = `sso-${randomBytes(3).toString('hex')}.example`;
let owner: Staff;
let tenantName: string;

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

test('HNV-26-06 · an owner proves the domain, connects the provider and turns SSO on', async ({
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

test('HNV-02-08 · a new person signs in with SSO and joins with the chosen role', async ({
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

test('HNV-02-09 · the provider must have verified the address', async ({ browser }) => {
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

test('HNV-02-10 · with SSO required, a password sign-in is turned to SSO', async ({
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

test('HNV-26-07 · the security page passes axe and fits a phone, in English and Arabic', async ({
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
