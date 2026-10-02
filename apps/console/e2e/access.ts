/**
 * Helpers for the team, security, single sign-on, passkey and platform journeys: two-factor
 * authentication through the API, platform operators, DNS records and the virtual authenticator.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb, setPlatformOperator } from '@hamnivo/db';
import { type BrowserContext, type CDPSession, expect, type Page } from '@playwright/test';
import { audit, PASSWORD, Staff, stack, totp, verifyEmail } from './support';

/**
 * Turns on two-factor authentication for a staff member and signs them in again with a code
 * (turning it on replaces the session). Returns the new session and the TOTP secret.
 */
export async function enableTotp(staff: Staff): Promise<{ staff: Staff; secret: string }> {
  const enabled = await staff.call<{ totpURI: string }>('POST', '/api/auth/two-factor/enable', {
    password: PASSWORD,
  });
  const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
  await staff.call('POST', '/api/auth/two-factor/verify-totp', { code: totp(secret) });
  return { staff: await staff.signInWithTotp(totp(secret)), secret };
}

/** A workspace owner with two-factor authentication on (security and support access need it). */
export async function ownerWithMfa(name: string, prefix: string) {
  const staff = await Staff.signUp(name, prefix);
  const slug = `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
  const membership = await staff.call<{ tenant: { id: string; name: string } }>(
    'POST',
    '/v1/tenants',
    { name: `${name} workspace`, slug },
  );
  staff.tenantId = membership.tenant.id;
  const enabled = await enableTotp(staff);
  return { staff: enabled.staff, secret: enabled.secret, tenant: membership.tenant };
}

/** Names a platform operator, as the server administrator does with the CLI. */
export async function appointOperator(
  email: string,
  role: 'platform_admin' | 'support_operator' | 'platform_viewer',
) {
  const db = createDb(stack().ownerDatabaseUrl, { max: 1 });
  try {
    await setPlatformOperator(db, { email, role });
  } finally {
    await db.$client.end();
  }
}

/** Publishes TXT records on the stack's DNS server (domain verification, A13). */
export function publishTxt(name: string, value: string) {
  const file = stack().dnsRecords;
  let records: Record<string, string[]> = {};
  try {
    records = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
  } catch {
    records = {};
  }
  records[name.toLowerCase()] = [...(records[name.toLowerCase()] ?? []), value];
  writeFileSync(file, JSON.stringify(records));
}

/** Invites someone by role key through the API and returns the one-time token. */
export async function inviteByApi(owner: Staff, email: string, roleKey: string): Promise<string> {
  const roles = await owner.call<{ items: Array<{ id: string; key: string }> }>(
    'GET',
    '/v1/admin/roles',
  );
  const roleId = roles.items.find((r) => r.key === roleKey)?.id;
  const invited = await owner.call<{ token: string }>('POST', '/v1/admin/invitations', {
    email,
    roleId,
    scope: { type: 'tenant' },
  });
  return invited.token;
}

/** A person who joined the owner's workspace with a role, signed in through the API. */
export async function memberOf(owner: Staff, name: string, prefix: string, roleKey: string) {
  const person = await Staff.signUp(name, prefix);
  // Accepting needs a confirmed address (the stack skips the confirmation email).
  await verifyEmail(person.email);
  const token = await inviteByApi(owner, person.email, roleKey);
  await person.call('POST', '/v1/invitations/accept', { token });
  person.tenantId = owner.tenantId;
  return person;
}

/**
 * Chromium's virtual authenticator (WebAuthn over CDP): a platform authenticator with resident
 * keys and user verification that answers every request by itself.
 */
export async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

/** No sideways scrolling at the widths people use (390 px phone included). */
export async function overflowAt(page: Page, widths = [320, 390, 768, 1280]): Promise<string[]> {
  const problems: string[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const extra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (extra > 1) problems.push(`${page.url()} at ${width}px: ${extra}px too wide`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return problems;
}

/** Opens a page in a language and waits for it to settle, then audits it with axe. */
export async function auditPage(page: Page, path: string, locale: 'en' | 'ar', label: string) {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}lang=${locale}`);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return audit(page, `${label} (${locale})`);
}

export async function signedInPage(context: BrowserContext, staff: Staff): Promise<Page> {
  await staff.signIn(context);
  return context.newPage();
}
