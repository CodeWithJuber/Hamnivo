/**
 * Studio journeys in a real browser against the gateway, worker and fake Chatwoot. Each test is
 * named after the UX state IDs (docs/design/UX-State-Matrix.csv) it covers. Apart from the first,
 * tests set up their own workspace through the API and sign the browser in with its cookie.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  ageSessions,
  customerAsks,
  endSessions,
  PASSWORD,
  seedWorkspace,
  stack,
  tabTo,
  totp,
  uniqueEmail,
  waitForRun,
} from './support';

const MARKDOWN = `# Shipping

Orders ship within two business days. Delivery to Karachi takes three to five days.

## Returns

You can return a book within 14 days of delivery.
`;

test('HNV-02-01 HNV-03-02 HNV-17-02 HNV-17-03 HNV-17-05 · sign up, create a workspace and a brand, connect Chatwoot, copy the install code', async ({
  page,
  context,
}) => {
  const { studioUrl, widgetOrigin, apiBase } = stack();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: studioUrl });

  // A protected page sends a signed-out visitor to sign in.
  await page.goto('/overview');
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
  await page.getByRole('link', { name: 'Create an account' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Your name').fill('Sara Staff');
  await page.getByLabel('Email address').fill(uniqueEmail('owner'));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Choose a workspace' })).toBeVisible();
  await expect(page.getByText('No workspaces yet')).toBeVisible();
  await page.getByLabel('Workspace name').fill(`Noor Books ${randomBytes(2).toString('hex')}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();

  // A new workspace starts in the guided setup; it can be left for later.
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Hamnivo' })).toBeVisible();
  await page.getByRole('link', { name: 'Finish later' }).click();
  // Then the overview says what to do first.
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByText('No brands yet')).toBeVisible();
  await page.getByRole('link', { name: 'Create a brand' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Brands and install' })).toBeVisible();
  await page.getByRole('button', { name: 'Create brand' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create a brand' });
  await create.getByLabel('Brand name').fill('Noor Books');
  await create.getByLabel('Allowed websites').fill('https://shop.example\nhttps://noor.example');
  await create.getByRole('button', { name: 'Create brand' }).click();
  await expect(create).toBeHidden();
  const card = page.getByTestId('brand-card');
  await expect(card).toContainText('Noor Books');
  await expect(card).toContainText('https://noor.example');

  // Websites can change later; taking one off says first that its open chats will end.
  await card.getByRole('button', { name: 'Edit Noor Books' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Noor Books' });
  await expect(edit.getByLabel('Brand name')).toHaveValue('Noor Books');
  await expect(edit.getByTestId('websites-removed')).toHaveCount(0);
  await edit.getByLabel('Allowed websites').fill('https://noor.example\nhttps://books.example');
  await expect(edit.getByTestId('websites-removed')).toContainText('https://shop.example');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Noor Books was saved.');
  await expect(card).toContainText('https://books.example');
  await expect(card).not.toContainText('https://shop.example');

  // Connecting says what will be set up before anything happens.
  await card.getByRole('button', { name: 'Connect Chatwoot' }).click();
  const connect = page.getByRole('dialog', { name: 'Connect Noor Books to Chatwoot' });
  await expect(connect).toContainText('an AI bot that answers in that inbox');
  await expect(connect).toContainText('It doesn’t answer customers until you publish it.');
  await connect.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(connect).toBeHidden();
  const connection = card.getByTestId('chat-connection');
  await expect(connection.getByText('Connected', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(connection).toContainText(/Chatwoot account \d+/);

  // The install code loads this brand's chat from the widget origin and talks to the gateway.
  const snippet = card.getByTestId('install-snippet');
  await expect(snippet).toContainText(`src="${widgetOrigin}/loader.js"`);
  await expect(snippet).toContainText(/data-widget-id="wid_[0-9a-z]+"/);
  await expect(snippet).toContainText(`data-api="${apiBase}"`);
  await card.getByTestId('copy-snippet').click();
  await expect(card.getByTestId('copy-snippet-status')).toHaveText('Install code copied.');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe((await snippet.textContent())?.trim());

  // Home now shows the brand connected, with its assistant still a draft.
  await page
    .getByRole('navigation', { name: 'Studio', exact: true })
    .getByRole('link', { name: 'Home', exact: true })
    .click();
  const row = page.getByTestId('overview-brands').locator('[data-brand="Noor Books"]');
  await expect(row).toContainText('Connected');
  await expect(row).toContainText('Draft only');
});

test('HNV-02-01 · a forgotten password leads to a neutral “check your email”', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
  const email = uniqueEmail('nobody');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  // The same words whether or not the account exists.
  await expect(page.getByText(`If an account uses ${email}`)).toBeVisible();
});

test('HNV-11-06 HNV-02-05 · publishing asks for a fresh sign-in, then the version is live', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  await workspace.staff.signIn(context);
  await page.goto('/agents');
  await page.getByTestId('agents-table').getByRole('link').first().click();

  const banner = page.getByTestId('not-live-banner');
  await expect(banner).toContainText('Saved is not live');
  await expect(banner).toContainText('gives customers no answers until you publish');

  // The sign-in is now an hour old; publishing needs one from the last 10 minutes.
  await ageSessions(workspace.staff.email);
  await page.getByTestId('publish-button').click();
  const dialog = page.getByTestId('publish-dialog');
  await expect(dialog).toContainText('This is the first version customers will see.');
  await dialog.getByRole('button', { name: 'Publish' }).click();

  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  await expect(reauth.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  await expect(reauth).toContainText(workspace.staff.email);
  await reauth.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();

  // The publish that asked for the sign-in carries on by itself.
  await expect(page.getByTestId('save-state')).toHaveText('Version 1 is live.');
  await expect(reauth).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(banner).toContainText('Customers get version 1 until you publish.');
  const live = page.getByTestId('versions').locator('[data-version="1"]');
  await expect(live).toHaveAttribute('data-state', 'published');
  await expect(live).toContainText('Live');
  await expect(live).not.toContainText('Fixed when published');
});

test('HNV-11-02 HNV-24-04 · keyboard only: change the draft, save it and publish it', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  await workspace.staff.signIn(context);
  await page.goto(`/agents/${workspace.agent?.id}`);
  await expect(page.getByTestId('not-live-banner')).toBeVisible();

  const purpose = page.getByLabel('Purpose');
  await tabTo(page, purpose);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Answer questions about books, orders and delivery.');
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes');

  await tabTo(page, page.getByRole('button', { name: 'Save draft' }));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('save-state')).toHaveText('Draft saved as version 1.');

  const publish = page.getByTestId('publish-button');
  await tabTo(page, publish);
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('publish-dialog');
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByRole('button', { name: 'Publish' }), 10);
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('save-state')).toHaveText('Version 1 is live.');
  await expect(dialog).toBeHidden();
  // Focus goes back to the button that opened the dialog.
  await expect(publish).toBeFocused();
  await expect(purpose).toHaveValue('Answer questions about books, orders and delivery.');
});

test('HNV-11-02 · a draft someone else changed is shown as a conflict, not overwritten', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  const { staff } = workspace;
  const agentId = workspace.agent?.id ?? '';
  await staff.signIn(context);
  await page.goto(`/agents/${agentId}`);
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved');

  // A teammate saves the same draft first.
  type Detail = { draft: { version: number; config: Record<string, unknown> } };
  const before = await staff.call<Detail>('GET', `/v1/admin/agents/${agentId}`);
  await staff.call('PUT', `/v1/admin/agents/${agentId}/draft`, {
    baseVersion: before.draft.version,
    config: { ...before.draft.config, purpose: 'Their purpose' },
  });

  await page.getByLabel('Instructions').fill('Keep answers short.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const conflict = page.getByTestId('conflict');
  await expect(conflict).toContainText('Someone saved a newer draft');
  await expect(conflict.getByRole('listitem')).toHaveText(['Purpose', 'Instructions']);
  // Nothing was saved over their draft.
  expect((await staff.call<Detail>('GET', `/v1/admin/agents/${agentId}`)).draft.config).toEqual(
    expect.objectContaining({ purpose: 'Their purpose' }),
  );

  await conflict.getByRole('button', { name: 'Keep my changes' }).click();
  await expect(page.getByTestId('save-state')).toHaveText('Draft saved as version 1.');
  await expect(conflict).toBeHidden();
  const after = await staff.call<Detail>('GET', `/v1/admin/agents/${agentId}`);
  expect(after.draft.config).toEqual(
    expect.objectContaining({ instructions: 'Keep answers short.' }),
  );
});

test('HNV-02-05 HNV-24-05 · when the session ends, signing in again keeps the unsaved work and finishes the save', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true });
  const agentId = workspace.agent?.id ?? '';
  await workspace.staff.signIn(context);
  await page.goto(`/agents/${agentId}`);
  const purpose = page.getByLabel('Purpose');
  await purpose.fill('Help readers find books and track orders.');

  await endSessions(workspace.staff.email);
  await page.getByRole('button', { name: 'Save draft' }).click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'expired');
  await expect(reauth.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  // Workspace content is hidden while nobody is signed in.
  await expect(page.locator('html')).toHaveAttribute('data-masked', /.*/);
  await reauth.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await reauth.getByRole('button', { name: 'Sign in again' }).click();

  await expect(reauth).toBeHidden();
  await expect(page.getByTestId('save-state')).toHaveText('Draft saved as version 1.');
  await expect(purpose).toHaveValue('Help readers find books and track orders.');
  await expect(page.locator('html')).not.toHaveAttribute('data-masked', /.*/);
  const saved = await page.request.get(`/v1/admin/agents/${agentId}`, {
    headers: { 'x-hamnivo-tenant': workspace.staff.tenantId },
  });
  expect((await saved.json()).draft.config.purpose).toBe(
    'Help readers find books and track orders.',
  );
});

test('HNV-02-03 · two-factor sign-in: turn it on, sign out, sign in with a code', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  const { staff } = workspace;
  await staff.signIn(context);
  await page.goto('/account');
  const status = page.getByTestId('two-factor-status');
  await expect(status).toHaveText('Off');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn on' }).click();

  const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify and turn on' }).click();
  await expect(status).toHaveText('On');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Email address').fill(staff.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Verify it’s you' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('HNV-17-02 HNV-19-02 · a model key is write-only: after saving, only its last characters show', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto('/models');
  await expect(page.getByText('No model connections yet')).toBeVisible();

  await page.getByRole('button', { name: 'Add connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a model connection' });
  const key = `sk-e2e-${randomBytes(12).toString('hex')}`;
  await dialog.getByLabel('Label').fill('OpenAI production');
  const keyField = dialog.getByLabel('API key');
  await expect(keyField).toHaveAttribute('type', 'password');
  await keyField.fill(key);
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('connection-added')).toContainText(
    `won’t be shown again. It ends in ${key.slice(-4)}.`,
  );
  await expect(page.getByTestId('connections-table').getByTestId('key-ending')).toContainText(
    key.slice(-4),
  );
  // The key is nowhere on the page, and the gateway never sends it back.
  expect(await page.content()).not.toContain(key);
  const listed = await workspace.staff.call('GET', '/v1/admin/model-connections');
  expect(JSON.stringify(listed)).not.toContain(key);
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  await expect(
    page.getByRole('dialog', { name: 'Add a model connection' }).getByLabel('API key'),
  ).toHaveValue('');
});

test('HNV-14-01 HNV-14-02 HNV-14-04 · upload a Markdown file, see it become ready, preview a search', async ({
  page,
  context,
}, testInfo) => {
  const workspace = await seedWorkspace();
  await workspace.staff.signIn(context);
  await page.goto('/knowledge');
  await expect(page.getByText('Add your first trusted source')).toBeVisible();

  await page.getByRole('button', { name: 'Add source' }).first().click();
  const sourceDialog = page.getByRole('dialog', { name: 'Add a knowledge source' });
  await sourceDialog.getByLabel('Brand', { exact: true }).selectOption({ label: 'Noor Books' });
  await sourceDialog.getByLabel('Source name').fill('Help centre');
  await sourceDialog.getByRole('button', { name: 'Add source' }).click();
  await expect(sourceDialog).toBeHidden();
  await expect(page.getByTestId('sources')).toContainText('Help centre');
  await expect(page.getByTestId('sources')).toContainText('Public answers');

  await page.getByRole('button', { name: 'Add document' }).first().click();
  const upload = page.getByRole('dialog', { name: 'Add a document' });
  await upload.getByLabel('Title').fill('Shipping and returns');
  await upload.getByRole('radio', { name: 'Upload a file' }).click();
  const fileInput = upload.getByLabel('File', { exact: true });
  // Too large: said at once, before anything is sent.
  const big = testInfo.outputPath('big.md');
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  await fileInput.setInputFiles(big);
  await expect(upload.getByText('Files can be up to 5 MB.')).toBeVisible();
  const file = testInfo.outputPath('shipping.md');
  writeFileSync(file, MARKDOWN);
  await fileInput.setInputFiles(file);
  await expect(upload.getByText(/^Chosen: shipping\.md/)).toBeVisible();
  await upload.getByRole('button', { name: 'Add document' }).click();
  await expect(upload).toBeHidden();

  // Checked and indexed first; answers can use it once it is Ready.
  const row = page
    .getByTestId('documents-table')
    .locator('tr[data-document="Shipping and returns"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-doc-state', 'ready', { timeout: 30_000 });
  await expect(row).toContainText('Ready');
  await expect(row).toContainText('Current');

  await page.getByLabel('Question').fill('How long does delivery to Karachi take?');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const passage = page.getByTestId('passage').first();
  await expect(passage).toContainText('Karachi');
  await expect(passage.getByTestId('passage-score')).toHaveText(/^Score \d\.\d{3}$/);
});

test('HNV-13-06 · stop AI replies for one brand, see it everywhere, then let the AI answer again', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const { staff, brand } = workspace;
  await staff.signIn(context);
  await page.goto('/overview');
  await expect(page.getByText('The AI isn’t stopped anywhere.')).toBeVisible();

  // The danger button in the header is on every page and leads to the Stop AI page, where the
  // stop is made. Stop AI is not an entry in the menu.
  await expect(
    page.getByRole('navigation', { name: 'Studio', exact: true }).getByRole('link', {
      name: 'Stop AI',
    }),
  ).toHaveCount(0);
  await page.getByTestId('stop-ai-button').click();
  await expect(page).toHaveURL(/\/stop-ai/);
  await page.getByTestId('stop-ai-open').click();
  const dialog = page.getByTestId('stop-ai-dialog');
  await dialog.getByRole('radio', { name: 'One brand' }).click();
  await dialog.getByLabel('Brand', { exact: true }).selectOption({ label: 'Noor Books' });
  await dialog.getByLabel('Reason').fill('Wrong prices in answers');
  await dialog.getByRole('button', { name: 'Stop AI replies' }).click();
  await expect(dialog).toBeHidden();

  // The stop shows on every page: back on Home, the banner and the header say so.
  await page
    .getByRole('navigation', { name: 'Studio', exact: true })
    .getByRole('link', { name: 'Home', exact: true })
    .click();
  const banner = page.getByTestId('kill-switch-banner');
  await expect(banner).toContainText('AI replies are stopped');
  await expect(banner).toContainText('Brand: Noor Books');
  await expect(banner).toContainText('Reason: Wrong prices in answers');
  await expect(page.getByTestId('ai-stopped-status')).toBeVisible();
  type Switches = { items: Array<{ scope: string; targetId: string | null; active: boolean }> };
  expect((await staff.call<Switches>('GET', '/v1/admin/kill-switches')).items).toEqual([
    expect.objectContaining({ scope: 'brand', targetId: brand.id, active: true }),
  ]);

  await banner.getByRole('link', { name: 'Review stops' }).click();
  const active = page.getByTestId('active-stops');
  await expect(active).toContainText('Wrong prices in answers');
  await active.getByRole('button', { name: 'Let AI answer again: Brand: Noor Books' }).click();
  const clear = page.getByTestId('clear-stop-dialog');
  await clear.getByRole('button', { name: 'Let AI answer' }).click();
  await expect(clear).toBeHidden();

  await expect(page.getByTestId('past-stops')).toContainText('Resumed');
  await expect(banner).toBeHidden();
  await expect(page.getByTestId('ai-stopped-status')).toBeHidden();
  expect((await staff.call<Switches>('GET', '/v1/admin/kill-switches')).items).toEqual([
    expect.objectContaining({ active: false }),
  ]);
});

test('HNV-11-01 · a customer conversation shows up in Runs, with its steps and no message text', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await customerAsks(workspace.brand.widgetId, 'Assalamu alaikum, where is my order?');
  await waitForRun(workspace.staff);
  await workspace.staff.signIn(context);

  await page.goto('/overview');
  await expect(page.getByTestId('overview-runs').getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: 'View all runs' }).click();

  const row = page.getByTestId('runs-table').locator('tbody tr').first();
  await expect(row).toHaveAttribute('data-outcome', 'replied');
  await expect(row).toContainText('Replied');
  await expect(row).toContainText('v1');
  const view = row.getByTestId('view-run');
  await view.click();
  const sheet = page.getByTestId('run-sheet');
  await expect(sheet.getByRole('heading', { name: 'Run details' })).toBeVisible();
  await expect(sheet).toContainText('Reply to customer');
  await expect(sheet.getByTestId('run-steps').getByRole('listitem').first()).toBeVisible();
  // Runs keep what happened, never what was said.
  await expect(sheet).not.toContainText('where is my order');

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(view).toBeFocused();
});
