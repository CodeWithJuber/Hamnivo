/**
 * The staff inbox in a real browser (boards 07–10): queues, the conversation workspace, taking
 * over, replying, internal notes, resolving, live updates from colleagues, right-to-left Arabic, a
 * 390 px phone and keyboard-only use, with axe audits along the way.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createDb } from '@hamnivo/db';
import { expect, type Page, test } from '@playwright/test';
import {
  audit,
  customerAsks,
  SHOP,
  Staff,
  seedWorkspace,
  stack,
  tabTo,
  type Workspace,
} from './support';

interface Summary {
  id: string;
  ownerMode: string;
  ownershipEpoch: number;
}

let workspace: Workspace;
/** A customer who asked for a person, and their widget session. */
let waiting: string;
let waitingToken: string;
/** A conversation the AI answers. */
let answered: string;

/** A customer starts a chat and asks for a person, as the widget's "Talk to a person" does. */
async function customerAsksForPerson(widgetId: string, text: string) {
  const { apiBase, widgetOrigin } = stack();
  const headers = { origin: widgetOrigin, 'content-type': 'application/json' };
  const session = await fetch(`${apiBase}/v1/widget/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ widgetId, hostOrigin: SHOP, locale: 'en' }),
  });
  const { accessToken } = (await session.json()) as { accessToken: string };
  const auth = { ...headers, authorization: `Bearer ${accessToken}` };
  const started = await fetch(`${apiBase}/v1/widget/conversations`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ clientMessageId: randomUUID(), firstMessage: text }),
  });
  const { id } = (await started.json()) as { id: string };
  const handoff = await fetch(`${apiBase}/v1/widget/conversations/${id}/handoff`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientRequestId: randomUUID(), note: 'I would like a person' }),
  });
  expect(handoff.status, 'handoff').toBe(200);
  return { id, accessToken };
}

/** Customer-visible messages, as the widget reads them. */
async function customerSees(conversationId: string, accessToken: string): Promise<string> {
  const { apiBase, widgetOrigin } = stack();
  const response = await fetch(`${apiBase}/v1/widget/conversations/${conversationId}/messages`, {
    headers: { origin: widgetOrigin, authorization: `Bearer ${accessToken}` },
  });
  return JSON.stringify(await response.json());
}

async function inbox(staff: Staff, query = 'queue=all') {
  return staff.call<{ items: Summary[] }>('GET', `/v1/inbox/conversations?${query}`);
}

/** Marks an address as confirmed, as following the link in the verification email would. */
async function confirmEmail(email: string) {
  const db = createDb(stack().databaseUrl, { max: 1 });
  try {
    await db.$client.query('UPDATE auth."user" SET email_verified = true WHERE email = $1', [
      email,
    ]);
  } finally {
    await db.$client.end();
  }
}

/** Invites a colleague with a role and returns them signed up in the same workspace. */
async function colleague(owner: Staff, name: string, role: string): Promise<Staff> {
  const roles = await owner.call<{ items: Array<{ id: string; key: string }> }>(
    'GET',
    '/v1/admin/roles',
  );
  const person = await Staff.signUp(name, 'colleague');
  await confirmEmail(person.email);
  const invited = await owner.call<{ token: string }>('POST', '/v1/admin/invitations', {
    email: person.email,
    roleId: roles.items.find((r) => r.key === role)?.id,
    scope: { type: 'tenant' },
  });
  await person.call('POST', '/v1/invitations/accept', { token: invited.token });
  person.tenantId = owner.tenantId;
  return person;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
  ({ id: answered } = await customerAsks(workspace.brand.widgetId, 'Where is my order HM-2048?'));
  ({ id: waiting, accessToken: waitingToken } = await customerAsksForPerson(
    workspace.brand.widgetId,
    'Can I change my delivery address?',
  ));
  await expect
    .poll(async () => (await inbox(workspace.staff, 'queue=unassigned')).items.map((i) => i.id), {
      timeout: 30_000,
    })
    .toContain(waiting);
});

test('HNV-08-01 HNV-08-02 HNV-09-01 HNV-09-02 HNV-10-03 HNV-10-04 · take over a waiting customer, reply, add a note, resolve', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  const queues = page.getByRole('navigation', { name: 'Queues' });
  await expect(queues.getByRole('link', { name: /Waiting for a person/ })).toContainText('1');
  await queues.getByRole('link', { name: /Waiting for a person/ }).click();
  await expect(page).toHaveURL(/queue=unassigned/);
  const rows = page.getByTestId('inbox-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Waiting');
  await rows.first().click();

  const pane = page.getByTestId('conversation-pane');
  await expect(pane.getByTestId('conversation-title')).toHaveText('Visitor');
  await expect(pane.getByTestId('ownership-banner')).toContainText(
    'The customer asked for a person',
  );
  // Hamnivo's handoff packet is a staff-only summary, never shown as a person's message.
  await expect(pane.locator('[data-kind="hamnivo-note"]')).toContainText('Handoff summary');
  expect(await audit(page, 'inbox conversation (waiting)')).toEqual([]);

  await pane.getByTestId('take-over').click();
  await expect(pane.getByTestId('ownership-banner')).toHaveCount(0);
  await expect(pane).toHaveAttribute('data-owner-mode', 'HUMAN_ACTIVE');

  const reply = pane.getByTestId('composer-public');
  await reply.fill('Hi, I can change it for you. What is the new address?');
  await expect(pane.getByText('Draft saved')).toBeVisible();
  await pane.getByTestId('send-reply').click();
  await expect(pane.getByTestId('timeline')).toContainText(
    'Hi, I can change it for you. What is the new address?',
  );
  await expect(reply).toHaveValue('');

  await pane.getByTestId('lane-internal').click();
  const note = pane.getByTestId('composer-internal');
  await note.fill('Check the courier before changing HM-2048.');
  await pane.getByTestId('add-note').click();
  const noteItem = pane.locator('[data-kind="note"]').filter({ hasText: 'Check the courier' });
  await expect(noteItem).toContainText('Internal note');
  // The customer's widget gets the reply, never the note.
  await expect
    .poll(() => customerSees(waiting, waitingToken), { timeout: 15_000 })
    .toContain('What is the new address?');
  expect(await customerSees(waiting, waitingToken)).not.toContain('Check the courier');

  await pane.getByTestId('resolve').click();
  await expect(pane).toHaveAttribute('data-status', 'resolved');
  await expect(pane.getByTestId('reopen')).toBeVisible();
  expect(await audit(page, 'inbox conversation (resolved)')).toEqual([]);
});

test('HNV-08-05 HNV-09-06 · a colleague’s takeover and typing show up live, and replies are held back', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const lead = await colleague(workspace.staff, 'Rayan Lead', 'supervisor');
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${answered}`);
  const pane = page.getByTestId('conversation-pane');
  await expect(pane.getByTestId('ownership-banner')).toContainText('is answering');
  await pane.getByTestId('take-over').click();
  await expect(pane).toHaveAttribute('data-owner-mode', 'HUMAN_ACTIVE');

  // Another person types, then takes the conversation over; no reload needed to see either.
  await lead.call('POST', `/v1/inbox/conversations/${answered}/presence`, {
    state: 'typing',
    lane: 'public',
  });
  await expect(pane.getByTestId('presence')).toContainText('Rayan Lead is typing a reply');
  await expect(pane.getByTestId('collision')).toContainText('Rayan Lead is also typing a reply');
  await lead.call('POST', `/v1/inbox/conversations/${answered}/assign`, { to: { kind: 'me' } });
  await expect(pane.getByTestId('ownership-banner')).toContainText(
    'Rayan Lead is handling this conversation.',
  );
  await expect(pane.getByTestId('send-reply')).toBeDisabled();
  await expect(pane.getByTestId('composer')).toContainText('Ask to take over before replying');
  // Notes stay possible for everyone who may write them.
  await pane.getByTestId('lane-internal').click();
  await pane.getByTestId('composer-internal').fill('I spoke to this customer yesterday.');
  await pane.getByTestId('add-note').click();
  await expect(pane.locator('[data-kind="note"]')).toContainText('I spoke to this customer');
});

test('HNV-07-03 · Arabic: the inbox reads right to left and passes axe', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${waiting}?lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'صندوق الوارد' })).toBeVisible();
  await expect(page.getByTestId('composer')).toContainText('ملاحظة داخلية');
  expect(await audit(page, 'inbox (ar)')).toEqual([]);
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(extra).toBeLessThanOrEqual(1);
});

test('HNV-07-01 HNV-07-06 · a 390 px phone: queue, then conversation, then details, and back', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/inbox');
  const queue = page.getByTestId('inbox-queue');
  await expect(queue).toBeVisible();
  await page.getByTestId('inbox-row').first().click();
  const pane = page.getByTestId('conversation-pane');
  await expect(pane).toBeVisible();
  await expect(queue).toBeHidden();
  await expect(page.getByTestId('composer')).toBeVisible();

  await pane.getByTestId('details-toggle').click();
  const sheet = page.getByTestId('details-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('customer-context')).toContainText('Not signed in');
  expect(await audit(page, 'inbox details sheet (390)')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(pane.getByTestId('details-toggle')).toBeFocused();

  await pane.getByTestId('back-to-queue').click();
  await expect(queue).toBeVisible();
  await expect(page.locator('[data-row-link]:focus')).toHaveCount(1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const extra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(extra, `${width}px`).toBeLessThanOrEqual(1);
  }
});

test('HNV-24-04 · keyboard only: move through the queue, open, reply with Ctrl+Enter, come back with Esc', async ({
  page,
  context,
}) => {
  const { id } = await customerAsksForPerson(workspace.brand.widgetId, 'Do you ship to Lahore?');
  await expect
    .poll(async () => (await inbox(workspace.staff, 'queue=unassigned')).items.map((i) => i.id), {
      timeout: 30_000,
    })
    .toContain(id);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The newest conversation is first in "All"; it stays there after being taken over.
  await open(page, '/inbox');
  const first = page.locator('[data-row-link]').first();
  await expect(page.locator(`[data-conversation-id="${id}"]`)).toHaveAttribute(
    'data-conversation-id',
    id,
  );
  await tabTo(page, first);
  // One row is a tab stop; arrows (or J and K) move between rows.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('k');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  const pane = page.getByTestId('conversation-pane');
  await expect(pane.getByTestId('conversation-title')).toBeFocused();

  await tabTo(page, pane.getByTestId('take-over'));
  await page.keyboard.press('Enter');
  await expect(pane).toHaveAttribute('data-owner-mode', 'HUMAN_ACTIVE');
  const reply = pane.getByTestId('composer-public');
  await tabTo(page, reply);
  await page.keyboard.type('Yes, we ship to Lahore in 3 days.');
  // Enter alone makes a new line; Ctrl+Enter sends.
  await page.keyboard.press('Control+Enter');
  await expect(pane.getByTestId('timeline')).toContainText('Yes, we ship to Lahore in 3 days.');
  await expect(reply).toHaveValue('');

  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-conversation-id="${id}"] [data-row-link]`)).toBeFocused();
});

test('HNV-09-05 · the AI suggests a reply with its sources; nothing is sent until a person sends it', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${waiting}`);
  const pane = page.getByTestId('conversation-pane');
  if ((await pane.getAttribute('data-status')) === 'resolved') {
    await pane.getByTestId('reopen').click();
    await expect(pane).toHaveAttribute('data-status', 'open');
  }
  const before = await pane.getByTestId('timeline-message').count();
  await pane.getByTestId('copilot').click();
  const suggestion = pane.getByTestId('copilot-suggestion');
  await expect(suggestion).toContainText('Suggested reply');
  await expect(suggestion).toContainText('nothing is sent on its own');
  await page.waitForTimeout(1000);
  await expect(pane.getByTestId('timeline-message')).toHaveCount(before);
  await suggestion.getByTestId('copilot-use').click();
  await expect(pane.getByTestId('composer-public')).not.toHaveValue('');
});

test('HNV-06-04 · offline: the inbox says so and keeps the draft in the browser', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `/inbox/${waiting}`);
  const pane = page.getByTestId('conversation-pane');
  await context.setOffline(true);
  await expect(page.getByTestId('inbox-connection')).toContainText('You’re offline');
  await pane.getByTestId('lane-internal').click();
  await pane.getByTestId('composer-internal').fill('Written while offline');
  await expect(pane.getByText('Offline: draft kept in this browser')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('inbox-connection')).toHaveCount(0, { timeout: 20_000 });
  await expect(pane.getByText('Draft saved')).toBeVisible({ timeout: 20_000 });
  const drafts = await workspace.staff.call<{ drafts: Array<{ lane: string; text: string }> }>(
    'GET',
    `/v1/inbox/conversations/${waiting}/drafts`,
  );
  expect(drafts.drafts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ lane: 'internal', text: 'Written while offline' }),
    ]),
  );
});

test('HNV-08-03 HNV-08-04 · filters that match nothing, then a checked bulk change with a result per conversation', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/inbox');
  const queue = page.getByTestId('inbox-queue');
  await queue.getByRole('button', { name: 'Filters' }).click();
  await page.getByTestId('inbox-filters').getByLabel('Status').selectOption('snoozed');
  await expect(queue).toContainText('No conversations match these filters');
  expect(await audit(page, 'inbox filters (no matches)')).toEqual([]);
  await queue.getByTestId('clear-filters').click();
  await expect(page.getByTestId('inbox-row')).toHaveCount(3);

  // X selects the row that has focus; a click on the box works too.
  await page.getByTestId('inbox-row').first().focus();
  await page.keyboard.press('x');
  await page.getByTestId('row-select').nth(1).click();
  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toContainText('Selected: 2');
  await bar.getByRole('button', { name: 'Resolve' }).click();
  // A dry run first says what the change would reach.
  const confirm = page.getByTestId('bulk-confirm');
  await expect(confirm).toContainText('Can be changed: 2.');
  expect(await audit(page, 'inbox bulk confirmation')).toEqual([]);
  await confirm.getByRole('button', { name: 'Change 2' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Done: 2. Failed: 0.');
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('inbox-row')).toHaveCount(1);
});

test('screenshots for visual review: inbox and conversation, English and Arabic, desktop and phone', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const folder = new URL('./screenshots/', import.meta.url);
  mkdirSync(folder, { recursive: true });
  const context = await browser.newContext();
  await workspace.staff.signIn(context);
  const page = await context.newPage();
  for (const locale of ['en', 'ar'] as const) {
    for (const width of [1440, 390]) {
      for (const [name, path] of Object.entries({
        inbox: '/inbox',
        conversation: `/inbox/${waiting}`,
      })) {
        await page.setViewportSize({ width, height: 900 });
        await open(page, `${path}?lang=${locale}`);
        await page.screenshot({
          path: new URL(`inbox-${name}-${locale}-${width}.png`, folder).pathname,
          animations: 'disabled',
        });
      }
    }
  }
  await context.close();
});
