/**
 * Studio as its owner meets it on a fresh server: served by the production edge, calling the API
 * on another origin with cookies, under the edge's Content Security Policy. See
 * playwright.production.config.ts; run by scripts/ci/production-smoke.sh.
 */
import { expect, test } from '@playwright/test';

function origin(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (scripts/ci/production-smoke.sh does).`);
  return value;
}

const APP = origin('SMOKE_APP_ORIGIN');
const API = origin('SMOKE_API_ORIGIN');
const CHAT = origin('SMOKE_CHAT_ORIGIN');

test('a new owner signs up in Studio, sets up a brand, connects Chatwoot and saves the agent', async ({
  page,
}) => {
  // Anything the page's security policy blocks is a failure. Zod's probe for eval support is the
  // one expected refusal: it falls back to plain parsing when eval is blocked.
  const refused: string[] = [];
  await page.exposeFunction('reportRefusal', (entry: string) => refused.push(entry));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.blockedURI === 'eval') return;
      (window as unknown as { reportRefusal(entry: string): void }).reportRefusal(
        `${event.effectiveDirective} ${event.blockedURI}`,
      );
    });
  });

  const first = await page.goto(`${APP}/overview`);
  const csp = (await first?.allHeaders())?.['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain(`connect-src 'self' ${API}`);
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);

  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill('Studio Owner');
  await page.getByLabel('Email address').fill(`studio-${Date.now()}@hamnivo.example`);
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Choose a workspace' })).toBeVisible();
  // The session lives in a secure, script-proof cookie on the API's origin.
  const cookies = await page.context().cookies(API);
  expect(cookies.some((c) => c.name.startsWith('__Secure-') && c.secure && c.httpOnly)).toBe(true);

  await page.getByLabel('Workspace name').fill('Studio Books');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  await page.getByRole('link', { name: 'Create a brand' }).click();
  await page.getByRole('button', { name: 'Create brand' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create a brand' });
  await create.getByLabel('Brand name').fill('Studio Books');
  await create.getByLabel('Allowed websites').fill('https://shop.hamnivo.example');
  await create.getByRole('button', { name: 'Create brand' }).click();
  await expect(create).toBeHidden();
  const card = page.getByTestId('brand-card');
  // The install code names this server's chat and API.
  const snippet = card.getByTestId('install-snippet');
  await expect(snippet).toContainText(`src="${CHAT}/loader.js"`);
  await expect(snippet).toContainText(`data-api="${API}"`);

  // Changing the websites is a PATCH to the API origin.
  await card.getByRole('button', { name: 'Edit Studio Books' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Studio Books' });
  await edit
    .getByLabel('Allowed websites')
    .fill('https://shop.hamnivo.example\nhttps://books.hamnivo.example');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(card).toContainText('https://books.hamnivo.example');

  // Connecting provisions the brand in the real Chatwoot and creates its agent as a draft.
  await card.getByRole('button', { name: 'Connect Chatwoot' }).click();
  const connect = page.getByRole('dialog', { name: 'Connect Studio Books to Chatwoot' });
  await connect.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(connect).toBeHidden({ timeout: 60_000 });
  await expect(
    card.getByTestId('chat-connection').getByText('Connected', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });

  // Saving the agent's draft is a PUT to the API origin.
  await page.getByRole('link', { name: 'Overview' }).first().click();
  await page
    .getByTestId('overview-brands')
    .locator('[data-brand="Studio Books"]')
    .getByRole('link', { name: 'Open agent' })
    .click();
  await page.getByLabel('Purpose').fill('Answer questions about books, orders and delivery.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('save-state')).toHaveText('Draft saved as version 1.');

  expect(refused).toEqual([]);
});
