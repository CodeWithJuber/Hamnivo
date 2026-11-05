/**
 * AI drafts awaiting review (HNV-09-05) in a real browser: an assist-mode agent drafts a reply to
 * each customer message from public knowledge; a person approves one and rejects another, with a
 * reason, and the queue says which conversations have a draft ready. English, and Arabic on a
 * 390 px phone, with axe audits.
 */
import { expect, type Page, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, customerAsks, seedKnowledge, seedWorkspace, type Workspace } from './support';

let workspace: Workspace;

interface Drafts {
  pending: { id: string; text: string } | null;
  latest: { id: string; state: string } | null;
}

const draftsOf = (id: string) =>
  workspace.staff.call<Drafts>('GET', `/v1/inbox/conversations/${id}/ai-drafts`);

/** A customer asks; the assist agent's draft is waiting for review. */
async function asksForDraft(text: string): Promise<string> {
  const { id } = await customerAsks(workspace.brand.widgetId, text);
  await expect
    .poll(async () => (await draftsOf(id)).pending?.id ?? null, { timeout: 30_000 })
    .not.toBeNull();
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
  const { sourceId } = await seedKnowledge(
    workspace,
    '# Delivery address\n\nYou can change the delivery address before the order is dispatched.',
  );
  const agentId = workspace.agent?.id as string;
  const agent = await workspace.staff.call<{ published: { config: Record<string, unknown> } }>(
    'GET',
    `/v1/admin/agents/${agentId}`,
  );
  await workspace.staff.call('PUT', `/v1/admin/agents/${agentId}/draft`, {
    config: { ...agent.published.config, mode: 'assist', knowledgeSourceIds: [sourceId] },
  });
  await workspace.staff.call('POST', `/v1/admin/agents/${agentId}/publish`, {});
});

test('HNV-09-05 · an AI draft is approved as written, and another rejected with a reason; nothing is sent on its own', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const first = await asksForDraft('Can I change my delivery address?');
  const second = await asksForDraft('Do you deliver on Sundays?');
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });

  // The queue says a draft is ready.
  await open(page, '/inbox?queue=unassigned');
  await expect(
    page.locator(`[data-conversation-id="${first}"]`).getByTestId('draft-ready'),
  ).toHaveText('Draft ready');

  await open(page, `/inbox/${first}`);
  const pane = page.getByTestId('conversation-pane');
  const card = pane.getByTestId('ai-draft');
  await expect(card.getByRole('heading', { name: 'AI draft for review' })).toBeVisible();
  await expect(card).toContainText('Nothing is sent until you approve it.');
  const text = ((await card.getByTestId('ai-draft-text').textContent()) ?? '').trim();
  expect(text).not.toBe('');
  // Nothing reached the customer yet.
  const before = await pane.getByTestId('timeline-message').count();
  expect(await audit(page, 'AI draft (en)')).toEqual([]);

  await card.getByRole('button', { name: 'Approve and send' }).click();
  await expect(pane.getByTestId('ai-draft-ended')).toContainText('sent this draft.');
  await expect(pane.getByTestId('timeline-message')).toHaveCount(before + 1);
  await expect(pane.getByTestId('timeline-message').last()).toContainText(text.slice(0, 20));
  expect((await draftsOf(first)).latest?.state).toBe('approved');

  // The second is rejected: a reason is asked for, and nothing is sent.
  await open(page, `/inbox/${second}`);
  const other = page.getByTestId('conversation-pane');
  const count = await other.getByTestId('timeline-message').count();
  await other.getByTestId('ai-draft').getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByTestId('reject-draft-dialog');
  await dialog.getByRole('button', { name: 'Reject draft' }).click();
  await expect(dialog).toContainText('Choose a reason.');
  await dialog.getByRole('radio', { name: 'No reply is needed' }).click();
  expect(await audit(page, 'reject dialog (en)')).toEqual([]);
  await dialog.getByRole('button', { name: 'Reject draft' }).click();
  await expect(other.getByTestId('ai-draft-ended')).toContainText(
    'rejected this draft: No reply is needed.',
  );
  await page.waitForTimeout(500);
  await expect(other.getByTestId('timeline-message')).toHaveCount(count);
  expect((await draftsOf(second)).latest?.state).toBe('rejected');
});

test('HNV-09-05 · the draft card in Arabic on a phone', async ({ page, context }) => {
  test.setTimeout(120_000);
  const id = await asksForDraft('Where is my parcel?');
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `/inbox/${id}?lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const card = page.getByTestId('ai-draft');
  await expect(
    card.getByRole('heading', { name: 'مسودة من الذكاء الاصطناعي للمراجعة' }),
  ).toBeVisible();
  expect(await audit(page, 'AI draft (ar, 390 px)')).toEqual([]);
  expect(await overflowAt(page, [390])).toEqual([]);
});
