/**
 * Hand-offs offered to one person at a time (HNV-10-03, HNV-10-06, H02) in a real browser: a team
 * in offer mode, a chat handed to it offered to the only person online, the "Offered to you"
 * section with its countdown, declining with a reason (the offers end and the chat waits in the
 * queue) and accepting (the chat opens as mine). The team setting on the Support teams page.
 * English and Arabic, a 390 px phone, with axe audits.
 */
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, SHOP, seedWorkspace, stack, type Workspace } from './support';

let workspace: Workspace;
let teamId: string;

/** A customer starts a chat and asks for a person, as the widget's "Talk to a person" does. */
async function waitsForPerson(widgetId: string, text: string) {
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
    body: JSON.stringify({ clientRequestId: randomUUID(), note: 'A person, please' }),
  });
  expect(handoff.status, 'handoff').toBe(200);
  return id;
}

/** A chat handed to the team (routing would put it there), once it has been offered to me. */
async function offeredToMe(text: string) {
  await workspace.staff.call('POST', '/v1/inbox/availability/ping', { active: true });
  const id = await waitsForPerson(workspace.brand.widgetId, text);
  await workspace.staff.call('POST', `/v1/inbox/conversations/${id}/team`, { teamId });
  await expect
    .poll(
      async () =>
        (
          await workspace.staff.call<{ items: Array<{ id: string }> }>('GET', '/v1/inbox/offers')
        ).items.map((item) => item.id),
      { timeout: 30_000 },
    )
    .toContain(id);
  return id;
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
  const workspaces = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const team = await workspace.staff.call<{ id: string }>('POST', '/v1/admin/teams', {
    name: 'Care',
    workspaceId: workspaces.items[0]?.id ?? null,
  });
  teamId = team.id;
  const members = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/members',
  );
  await workspace.staff.call('PUT', `/v1/admin/teams/${teamId}/members`, {
    staffMemberIds: members.items.map((m) => m.id),
  });
  await workspace.staff.call('PUT', '/v1/inbox/availability', { status: 'online' });
});

test('H02 · a team offers chats to one person at a time, set on the Support teams page', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '/support-teams');
  const card = page.locator('[data-testid="team-card"][data-team="Care"]');
  await expect(card).toContainText('New chats wait in the team’s queue for anyone to take.');
  await card.getByRole('button', { name: 'Change how chats arrive in Care' }).click();
  const dialog = page.getByTestId('team-offers-dialog');
  await dialog.getByRole('radio', { name: /Offer it to one person at a time/ }).check();
  await dialog.getByRole('textbox', { name: 'Seconds to accept' }).fill('120');
  expect(await audit(page, 'team offers dialog (en)')).toEqual([]);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText(
    'New chats are offered to one person at a time, 120 seconds each.',
  );
  const teams = await workspace.staff.call<{
    items: Array<{ id: string; assignmentMode: string; offerTimeoutSeconds: number }>;
  }>('GET', '/v1/admin/teams');
  expect(teams.items.find((t) => t.id === teamId)).toMatchObject({
    assignmentMode: 'offer',
    offerTimeoutSeconds: 120,
  });
  expect(await audit(page, 'support teams (en)')).toEqual([]);
});

test('HNV-10-03 HNV-10-06 · a chat offered to me: the countdown, declining with a reason, accepting', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  const first = await offeredToMe('My order arrived damaged.');
  await open(page, '/inbox');
  const section = page.getByTestId('offers-section');
  await expect(section.getByRole('heading', { name: 'Offered to you' })).toBeVisible();
  const card = section.getByTestId('offer-card');
  await expect(card).toContainText('My order arrived damaged.');
  await expect(card.getByTestId('offer-countdown')).toHaveText(/^\d:\d\d left$/);
  await expect(
    page.locator(`[data-conversation-id="${first}"]`).getByTestId('offer-badge'),
  ).toContainText('Offered to you');
  expect(await audit(page, 'offered to you (en)')).toEqual([]);

  // Declined with a reason: with nobody else in the team, the chat waits in the queue.
  await card.getByTestId('offer-decline').click();
  const dialog = page.getByTestId('decline-offer-dialog');
  await dialog.getByRole('radio', { name: 'This is not my area' }).check();
  await dialog.getByLabel(/Note/).fill('Damaged goods go to returns.');
  expect(await audit(page, 'decline offer (en)')).toEqual([]);
  await dialog.getByRole('button', { name: 'Decline chat' }).click();
  await expect(section).toHaveCount(0);
  const after = await workspace.staff.call<{ offer: unknown; ownerMode: string }>(
    'GET',
    `/v1/inbox/conversations/${first}`,
  );
  expect(after).toMatchObject({ offer: null, ownerMode: 'WAITING_HUMAN' });

  // The next hand-off is offered again, and accepting opens it as mine.
  const second = await offeredToMe('Can I change the delivery address?');
  await expect(page.getByTestId('offer-card')).toContainText('delivery address');
  await page.getByTestId('offer-accept').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${second}`));
  const mine = await workspace.staff.call<{ ownerMode: string; ownerReason: string }>(
    'GET',
    `/v1/inbox/conversations/${second}`,
  );
  expect(mine).toMatchObject({ ownerMode: 'HUMAN_ACTIVE', ownerReason: 'offer_accepted' });

  // Arabic on a phone: right to left, nothing too wide.
  await offeredToMe('Where is my refund?');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/inbox?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('offers-section')).toContainText('معروضة عليك');
  expect(await audit(page, 'offered to you (ar, 390 px)')).toEqual([]);
  expect(await overflowAt(page, [390])).toEqual([]);
});
