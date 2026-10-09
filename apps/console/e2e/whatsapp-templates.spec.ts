/**
 * WhatsApp template messages in the inbox composer (D14) in a real browser against the gateway and
 * the fake Chatwoot. A customer writes on a WhatsApp number through the stack's control port (the
 * fake's receiveChannelMessage), and the conversation is made 25 hours old in the database and in
 * the fake, so WhatsApp takes only templates. Covered: the closed-window notice's Send a template,
 * the picker grouped by language with the ones Hamnivo cannot send shown with why, filling in the
 * values with the live preview, sending with what Chatwoot passes on, axe on each step, and the
 * picker in Arabic right to left on a phone with named values filled in from the conversation.
 */
import { readFileSync } from 'node:fs';
import { createDb, fromPublicId } from '@hamnivo/db';
import { expect, type Page, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, seedWorkspace, stack, type Workspace } from './support';

const control = (): string =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8')).chatwoot.control;

/** Calls one of the fake Chatwoot's test hooks (see fakeControlServer in stack.ts). */
async function fake<T>(hook: string, body: unknown): Promise<T> {
  const response = await fetch(`${control()}/${hook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${hook} → ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/** Runs SQL in the workspace's rows (row-level security), for a state the API cannot make. */
async function tenantSql(text: string, params: unknown[]) {
  const db = createDb(stack().databaseUrl, { max: 1 });
  try {
    await db.$client.query('BEGIN');
    await db.$client.query("SELECT set_config('app.tenant_id', $1, true)", [
      fromPublicId('tenant', workspace.staff.tenantId),
    ]);
    const result = await db.$client.query(text, params);
    await db.$client.query('COMMIT');
    return result;
  } finally {
    await db.$client.end();
  }
}

/** Meta's shape, as Chatwoot keeps it after syncing. */
const orderUpdate = {
  name: 'order_update',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way.' },
    { type: 'FOOTER', text: 'Noor Books' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Thanks' },
        { type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}' },
      ],
    },
  ],
};
const TEMPLATES = [
  orderUpdate,
  { ...orderUpdate, name: 'pending_one', status: 'PENDING' },
  { ...orderUpdate, name: 'login_code', category: 'AUTHENTICATION' },
  {
    ...orderUpdate,
    name: 'with_photo',
    components: [{ type: 'HEADER', format: 'IMAGE' }, ...orderUpdate.components],
  },
  {
    name: 'news_ar',
    language: 'ar',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'مرحبًا {{customer_name}}، لدى {{brand}} أخبار جديدة لك.' }],
  },
];

let workspace: Workspace;
let conversationId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true });
  const { staff, brand } = workspace;
  const { channel } = await staff.call<{ channel: { id: string } }>(
    'POST',
    `/v1/admin/brands/${brand.id}/channels/whatsapp`,
    {
      name: 'WhatsApp',
      // A number of its own, so the spec can run again against the same stack.
      phoneNumber: `+97150${String(Date.now()).slice(-7)}`,
      phoneNumberId: '5098765',
      businessAccountId: '6234567',
      accessToken: 'EAAG-permanent-system-user-token-templates',
      aiAnswers: false,
      defaultTeamId: null,
    },
  );
  const inboxUuid = fromPublicId('inbox', channel.id);
  const inbox = await tenantSql('SELECT external_inbox_id FROM authority_inboxes WHERE id = $1', [
    inboxUuid,
  ]);
  const inboxId = Number(inbox.rows[0]?.external_inbox_id);
  await fake('whatsapp-templates', {
    inboxId,
    templates: TEMPLATES,
    syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const asked = await fake<{ conversationId: number }>('receive-channel-message', {
    inboxId,
    from: '+971555000111',
    name: 'Hana',
    content: 'Is the blue one in stock?',
  });
  await expect
    .poll(
      async () =>
        (
          await staff.call<{ items: Array<{ id: string }> }>(
            'GET',
            '/v1/inbox/conversations?queue=all&channel=whatsapp',
          )
        ).items.map((item) => item.id),
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  const listed = await staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/inbox/conversations?queue=all&channel=whatsapp',
  );
  conversationId = listed.items[0]?.id ?? '';
  // A day later: WhatsApp (and the gateway) take only templates now.
  await tenantSql(
    `UPDATE conversation_controls SET last_customer_message_at = now() - interval '25 hours'
      WHERE inbox_id = $1 AND external_conversation_id = $2`,
    [inboxUuid, asked.conversationId],
  );
  await fake('age-conversation', { conversationId: asked.conversationId, hours: 25 });
});

async function open(page: Page, locale = 'en') {
  await page.goto(`/inbox/${conversationId}?lang=${locale}`);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
}

test('after 24 hours: send a template, filled in and checked in the preview', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const notice = page.getByTestId('reply-window-closed');
  await expect(notice).toHaveText(
    'WhatsApp only allows template messages now. You can reply again after the customer writes.',
  );
  await expect(page.getByTestId('composer-public')).toHaveAttribute('readonly', '');
  const opener = page.getByRole('button', { name: 'Send a template' });
  await opener.click();
  const dialog = page.getByTestId('template-dialog');
  await expect(dialog.getByRole('heading', { name: 'Send a WhatsApp template' })).toBeVisible();
  await expect(dialog.getByTestId('template-option')).toHaveCount(5);

  // Grouped by language; the ones Hamnivo cannot send say why and cannot be chosen.
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
    'American English',
    'Arabic',
  ]);
  const option = (name: string) => dialog.getByTestId('template-option').filter({ hasText: name });
  await expect(option('order_update')).toContainText('Utility');
  await expect(option('order_update')).toContainText('Hi {{1}}, your order {{2}} is on its way.');
  await expect(option('pending_one')).toHaveAttribute('aria-disabled', 'true');
  await expect(option('pending_one').getByTestId('template-reason')).toHaveText(
    'Waiting for Meta’s approval',
  );
  await expect(option('login_code').getByTestId('template-reason')).toHaveText(
    'One-time codes are sent by your own systems',
  );
  await expect(option('with_photo').getByTestId('template-reason')).toHaveText(
    'Templates with a photo, video or document header can’t be sent from here yet',
  );
  await expect(dialog.getByTestId('templates-synced')).toHaveText(
    'Templates last updated 5 minutes ago. New templates appear here after Chatwoot syncs them from Meta.',
  );
  const violations = await audit(page, 'template picker (en)');
  // Playwright waits for an enabled control; a person's click does nothing.
  await option('pending_one').click({ force: true });
  await expect(dialog.getByTestId('template-form')).toHaveCount(0);

  await dialog.getByRole('searchbox', { name: 'Search templates' }).fill('order');
  await expect(dialog.getByTestId('template-option')).toHaveCount(4);
  await option('order_update').click();

  // One field per value; the preview shows what is still empty, and Send waits for it.
  const first = dialog.getByLabel('Message {{1}}');
  await expect(first).toBeVisible();
  const preview = dialog.getByTestId('template-preview');
  await expect(preview.getByTestId('preview-body')).toHaveText(
    'Hi {{1}}, your order {{2}} is on its way.',
  );
  await expect(preview.getByTestId('preview-unfilled')).toHaveCount(2);
  await expect(preview.getByTestId('preview-footer')).toHaveText('Noor Books');
  const send = dialog.getByTestId('send-template');
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.getByText('Fill in 3 more values to send.')).toBeVisible();
  violations.push(...(await audit(page, 'template form (en)')));

  await first.fill('Hana');
  await dialog.getByLabel('Message {{2}}').fill('1042');
  const track = dialog.getByLabel('Button “Track”');
  await expect(track).toHaveAttribute('dir', 'ltr');
  await track.fill('1042');
  await expect(preview.getByTestId('preview-body')).toHaveText(
    'Hi Hana, your order 1042 is on its way.',
  );
  await expect(preview.getByTestId('preview-unfilled')).toHaveCount(0);
  await expect(send).not.toHaveAttribute('aria-disabled', 'true');
  violations.push(...(await audit(page, 'template filled in (en)')));

  const sent = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith(`/conversations/${conversationId}/messages`),
  );
  await send.click();
  expect((await sent).postDataJSON()).toMatchObject({
    template: {
      name: 'order_update',
      language: 'en_US',
      values: { body: { '1': 'Hana', '2': '1042' }, buttons: { '1': '1042' } },
    },
    visibility: 'public',
  });
  expect((await sent).postDataJSON().text).toBeUndefined();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Template sent.');
  // The transcript shows what the customer read.
  await expect(
    page.getByTestId('timeline').getByText('Hi Hana, your order 1042 is on its way.'),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(opener).toBeFocused();
  expect(violations).toEqual([]);
});

test('Arabic on a phone: the picker reads right to left, with named values filled in', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'أرسل قالبًا' }).click();
  const dialog = page.getByTestId('template-dialog');
  await expect(dialog.getByRole('heading', { name: 'إرسال قالب واتساب' })).toBeVisible();
  await expect(dialog.getByTestId('template-option')).toHaveCount(5);
  await expect(
    dialog
      .getByTestId('template-option')
      .filter({ hasText: 'pending_one' })
      .getByTestId('template-reason'),
  ).toHaveText('بانتظار موافقة Meta');
  const violations = await audit(page, 'template picker (ar, phone)');
  violations.push(...(await overflowAt(page, [320, 390])));
  await page.setViewportSize({ width: 390, height: 844 });

  await dialog.getByTestId('template-option').filter({ hasText: 'news_ar' }).click();
  // The customer's name and the brand come from the conversation.
  await expect(dialog.getByLabel('الرسالة {{customer_name}}')).toHaveValue('Hana');
  await expect(dialog.getByLabel('الرسالة {{brand}}')).toHaveValue('Noor Books');
  await expect(dialog.getByText('مُلئت من هذه المحادثة.')).toHaveCount(2);
  await expect(dialog.getByTestId('preview-body')).toHaveText(
    'مرحبًا Hana، لدى Noor Books أخبار جديدة لك.',
  );
  await expect(dialog.getByTestId('template-back')).toHaveText('كل القوالب');
  violations.push(...(await audit(page, 'template form (ar, phone)')));
  violations.push(...(await overflowAt(page, [320, 390])));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(violations).toEqual([]);
});
