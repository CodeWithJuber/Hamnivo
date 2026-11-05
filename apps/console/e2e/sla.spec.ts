/**
 * Reply-time targets (H12), urgent conversations nobody has taken (HNV-08-02) and a claim that
 * lost (HNV-08-06) in a real browser: targets set on the Business hours page with what happens to
 * an overdue conversation (leads alerted, moved to a team; ADR 0016), the due badge, the
 * urgent list above the queue with its Claim button, and a claim a colleague won first, which
 * names them. English and Arabic, a 390 px phone, with axe audits.
 */
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { memberOf, overflowAt } from './access';
import { audit, SHOP, type Staff, seedWorkspace, stack, type Workspace } from './support';

let workspace: Workspace;
let colleague: Staff;
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

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const urgentIds = async () =>
  (
    await workspace.staff.call<{ items: Array<{ id: string }> }>('GET', '/v1/inbox/urgent')
  ).items.map((i) => i.id);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
  colleague = await memberOf(workspace.staff, 'Rayan Lead', 'sla-colleague', 'agent');
  const workspaces = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const team = await workspace.staff.call<{ id: string }>('POST', '/v1/admin/teams', {
    name: 'Escalations',
    workspaceId: workspaces.items[0]?.id ?? null,
  });
  teamId = team.id;
});

test('H12 · set reply-time targets for a brand on the Business hours page', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, `/hours?brand=${workspace.brand.id}`);
  const form = page.getByTestId('reply-targets');
  await expect(page.getByRole('heading', { name: 'Reply-time targets' })).toBeVisible();
  await form.getByRole('checkbox', { name: 'Use reply-time targets for this brand' }).click();
  await form.getByRole('textbox', { name: 'First reply within for Urgent' }).fill('5');
  await form.getByRole('textbox', { name: 'Next reply within for Urgent' }).fill('10');
  await form.getByRole('textbox', { name: 'First reply within for Medium' }).fill('1');
  await form
    .getByRole('combobox', { name: 'Unit for First reply within, Medium' })
    .selectOption('hours');
  // An overdue conversation: its leads are alerted, and it moves to a team after 10 minutes.
  const overdue = form.getByRole('group', { name: 'When a conversation goes past its target' });
  await overdue.getByRole('checkbox', { name: 'Alert team leads right away' }).click();
  await overdue.getByRole('checkbox', { name: 'Move it if nobody replies' }).click();
  await overdue.getByRole('textbox', { name: 'Move it after' }).fill('10');
  await overdue.getByRole('combobox', { name: 'Move it to' }).selectOption(teamId);
  expect(await audit(page, 'overdue settings (en)')).toEqual([]);
  await form.getByRole('button', { name: 'Save targets' }).click();
  await expect(form.getByRole('button', { name: 'Save targets' })).toBeDisabled();
  const saved = await workspace.staff.call<{
    enabled: boolean;
    targets: Record<string, { firstReplyMinutes: number | null }>;
    overdue: unknown;
  }>('GET', `/v1/admin/brands/${workspace.brand.id}/sla-policy`);
  expect(saved.enabled).toBe(true);
  expect(saved.targets.urgent?.firstReplyMinutes).toBe(5);
  expect(saved.targets.medium?.firstReplyMinutes).toBe(60);
  expect(saved.overdue).toEqual({
    alertLeads: true,
    moveAfterMinutes: 10,
    moveTo: { kind: 'team', teamId },
  });

  expect(await audit(page, 'reply-time targets (en)')).toEqual([]);
  await open(page, `/hours?brand=${workspace.brand.id}&lang=ar`);
  await expect(page.getByTestId('reply-targets')).toBeVisible();
  expect(await audit(page, 'reply-time targets (ar)')).toEqual([]);
  expect(await overflowAt(page, [390])).toEqual([]);
});

test('HNV-08-02 HNV-08-06 · urgent conversations nobody has taken, claimed from the queue; a lost claim names the winner', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const first = await waitsForPerson(workspace.brand.widgetId, 'I was charged twice!');
  const second = await waitsForPerson(workspace.brand.widgetId, 'My parcel is lost.');
  for (const id of [first, second]) {
    await workspace.staff.call('POST', `/v1/inbox/conversations/${id}/priority`, {
      priority: 'urgent',
    });
  }
  await expect.poll(urgentIds, { timeout: 30_000 }).toEqual([first, second]);

  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/inbox');
  const section = page.getByTestId('urgent-section');
  await expect(section.getByRole('heading', { name: /Urgent, nobody has taken it/ })).toBeVisible();
  const row = (id: string) => section.locator(`[data-urgent-id="${id}"]`);
  await expect(row(first)).toContainText('Asked for a person');
  await expect(row(first).getByTestId('sla-badge')).toContainText('Reply due in');
  // The queue row says it too.
  await expect(
    page.locator(`[data-conversation-id="${first}"]`).getByTestId('sla-badge'),
  ).toBeVisible();
  expect(await audit(page, 'urgent section (en)')).toEqual([]);

  // A colleague claims the first one while this view has not heard of it yet: the live stream
  // is held back, so the Claim button still shows.
  await page.route('**/v1/inbox/events', (route) => route.abort());
  const epoch = (
    await colleague.call<{ ownershipEpoch: number }>('GET', `/v1/inbox/conversations/${first}`)
  ).ownershipEpoch;
  await colleague.call('POST', `/v1/inbox/conversations/${first}/assign`, {
    to: { kind: 'me' },
    expectedEpoch: epoch,
  });
  await row(first).getByTestId('urgent-claim').click();
  await expect(page.getByTestId('urgent-lost')).toHaveText(
    'Rayan Lead already took this conversation.',
  );
  await expect(row(first)).toHaveCount(0);
  await page.unroute('**/v1/inbox/events');

  // The second is claimed from the list and opens.
  await row(second).getByTestId('urgent-claim').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${second}`));
  await expect(page.getByTestId('ownership-banner')).toHaveCount(0);
  await expect.poll(urgentIds).toEqual([]);

  // Arabic on a phone: a third urgent conversation, right to left, nothing too wide.
  const third = await waitsForPerson(workspace.brand.widgetId, 'Where is my refund?');
  await workspace.staff.call('POST', `/v1/inbox/conversations/${third}/priority`, {
    priority: 'urgent',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/inbox?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('urgent-section')).toContainText('عاجلة ولم يأخذها أحد');
  expect(await audit(page, 'urgent section (ar, 390 px)')).toEqual([]);
  expect(await overflowAt(page, [390])).toEqual([]);
});
