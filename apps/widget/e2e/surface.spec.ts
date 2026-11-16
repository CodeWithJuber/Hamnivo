import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { provisionStaffUser } from '@hamnivo/chatwoot';
import { createDb, fromPublicId } from '@hamnivo/db';
import { createIdentityAssertion } from '@hamnivo/server';
import { type BrowserContext, expect, type FrameLocator, type Page, test } from '@playwright/test';

/**
 * The customer surface in a browser (W02, W05–W07, W09, W11, W14, W15, W17–W19, W22–W28, H19),
 * on the stack from e2e/stack.ts: a host page on another origin, the loader, the widget and the
 * gateway.
 */

interface Stack {
  hostUrl: string;
  apiBase: string;
  consoleOrigin: string;
  widgetOrigin: string;
  widgetId: string;
  brandId: string;
  tenantId: string;
  cookie: string;
  identityKey: { kid: string; secret: string };
  databaseUrl: string;
  chatwootUrl: string;
  chatwootPlatformToken: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa6f5a40000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

async function staff(method: string, path: string, body?: unknown) {
  const s = stack();
  const response = await fetch(`${s.apiBase}${path}`, {
    method,
    headers: {
      origin: s.consoleOrigin,
      cookie: s.cookie,
      'x-hamnivo-tenant': s.tenantId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  expect(response.ok, `${method} ${path} → ${response.status} ${JSON.stringify(json)}`).toBe(true);
  return json;
}

const settings = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/widget-settings`, body);
const promptLimits = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/automations/prompt-limits`, body);
const widgetForms = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/widget-forms`, body);
const consentSettings = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/consent`, body);
const directLink = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/direct-link`, body);

async function openWidget(page: Page, path = '/'): Promise<FrameLocator> {
  await page.goto(`${stack().hostUrl}${path}`);
  const launcher = page.locator('[data-hamnivo-launcher]');
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  const frame = page.frameLocator('iframe[data-hamnivo-frame]');
  await expect(frame.getByTestId('ai-disclosure')).toBeVisible();
  return frame;
}

const textbox = (frame: FrameLocator) => frame.getByRole('textbox', { name: 'Write a message…' });

async function ask(frame: FrameLocator, text: string) {
  await textbox(frame).fill(text);
  await textbox(frame).press('Enter');
  await expect(frame.locator('[data-sender="customer"]').last()).toContainText(text);
}

async function signIn(page: Page, customer: { id: string; email?: string }) {
  const s = stack();
  const assertion = await createIdentityAssertion({
    widgetId: s.widgetId,
    key: { kid: s.identityKey.kid, alg: 'HS256', secret: s.identityKey.secret },
    customer: {
      id: customer.id,
      name: 'Amina Noor',
      ...(customer.email ? { email: customer.email, emailVerified: true } : {}),
    },
  });
  await page.evaluate(
    (signed) =>
      (window as unknown as { Hamnivo: { identify(a: string): Promise<void> } }).Hamnivo.identify(
        signed,
      ),
    assertion,
  );
}

/** Checks the chat in its frame, or the whole page where the chat is the page (W28). */
async function audit(page: Page, { frame = true } = {}) {
  const builder = new AxeBuilder({ page });
  if (frame) builder.include('iframe[data-hamnivo-frame]');
  const results = await builder.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** Nothing in the chat is wider than the chat (reflow at 320 px and 200 % zoom). */
async function fits(frame: FrameLocator) {
  const { scroll, client, wide } = await frame.locator('html').evaluate((html) => ({
    scroll: html.scrollWidth,
    client: html.clientWidth,
    // What sticks out, to say what to fix.
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > html.clientWidth + 1)
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 30)}" ends at ${Math.round(el.getBoundingClientRect().right)}`,
      ),
  }));
  expect(scroll, wide.join(' | ')).toBeLessThanOrEqual(client + 1);
}

/** Runs SQL as the app, inside the stack tenant (row-level security applies). */
async function asTenant<T>(query: string, params: unknown[]): Promise<T[]> {
  const db = createDb(stack().databaseUrl, { max: 1 });
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      fromPublicId('tenant', stack().tenantId),
    ]);
    const result = await client.query(query, params);
    await client.query('COMMIT');
    return result.rows as T[];
  } finally {
    client.release();
    await db.$client.end();
  }
}

const conversationOf = async (frame: FrameLocator) =>
  (await frame
    .locator('section[data-conversation-id]')
    .getAttribute('data-conversation-id')) as string;

async function waitForAnswer(frame: FrameLocator) {
  await expect(frame.locator('[data-sender="ai_primary"]').last()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('files (W09)', () => {
  test('attaches checked files, refuses a program, sends them, previews pictures and downloads', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await frame.getByTestId('file-input').setInputFiles([
      { name: 'photo.png', mimeType: 'image/png', buffer: PNG },
      { name: 'receipt.pdf', mimeType: 'application/pdf', buffer: PDF },
      // A program dressed as a PDF: the gateway reads the bytes, not the name.
      { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: EXE },
    ]);
    const chips = frame.getByTestId('file-chips').getByRole('listitem');
    await expect(chips.filter({ hasText: 'photo.png' })).toHaveAttribute('data-state', 'ready');
    await expect(chips.filter({ hasText: 'receipt.pdf' })).toHaveAttribute('data-state', 'ready');
    const refused = chips.filter({ hasText: 'invoice.pdf' });
    await expect(refused).toHaveAttribute('data-state', 'refused');
    await expect(refused).toContainText('This kind of file can’t be sent.');
    await frame.getByRole('button', { name: 'Remove invoice.pdf' }).click();
    await expect(chips).toHaveCount(2);
    await audit(page);

    await ask(frame, 'Here are the photo and the receipt');
    await expect(chips).toHaveCount(0);
    const picture = frame.getByRole('img', { name: 'Picture: photo.png' });
    await expect(picture).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    // The picture opens larger inside the chat. Escape closes the picture, not the chat, and
    // focus goes back to where it was.
    const view = frame.getByRole('button', { name: 'View photo.png larger' });
    await view.click();
    const larger = frame.getByRole('dialog', { name: 'Picture: photo.png' });
    await expect(larger.getByRole('img')).toBeVisible();
    await expect(larger.getByRole('button', { name: 'Close picture' })).toBeFocused();
    await audit(page);
    await page.keyboard.press('Escape');
    await expect(larger).toBeHidden();
    await expect(view).toBeFocused();
    await expect(page.locator('iframe[data-hamnivo-frame]')).toBeVisible();
    const download = page.waitForEvent('download');
    await frame.getByRole('button', { name: 'Download receipt.pdf' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('receipt.pdf');
    expect(
      readFileSync((await saved.path()) as string)
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
  });
});

test.describe('sending, drafts and offline (W06, W07, W11)', () => {
  test('keeps a draft across a reload', async ({ page }) => {
    let frame = await openWidget(page);
    await textbox(frame).fill('My order number is');
    await page.waitForTimeout(500);
    await page.reload();
    await page.locator('[data-hamnivo-launcher]').click();
    frame = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(textbox(frame)).toHaveValue('My order number is');
  });

  test('queues messages offline, lets the visitor take one back, then sends the rest once', async ({
    page,
    context,
  }) => {
    const frame = await openWidget(page);
    await ask(frame, 'First question');
    await waitForAnswer(frame);
    await context.setOffline(true);
    const banner = frame.getByTestId('connection');
    await expect(banner).toContainText('You’re offline.');
    await expect(frame.getByRole('button', { name: 'Queue' })).toBeVisible();
    await textbox(frame).fill('Kept for later');
    await textbox(frame).press('Enter');
    await textbox(frame).fill('Take this back');
    await textbox(frame).press('Enter');
    const queued = frame.locator('[data-state="queued"]');
    await expect(queued).toHaveCount(2);
    await expect(queued.first()).toContainText('Waiting for connection');
    await queued
      .filter({ hasText: 'Take this back' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(textbox(frame)).toHaveValue('Take this back');
    await expect(queued).toHaveCount(1);
    await textbox(frame).fill('');
    await audit(page);
    await context.setOffline(false);
    await expect(
      frame.locator('[data-sender="customer"][data-state="accepted"]').last(),
    ).toContainText('Kept for later', { timeout: 30_000 });
    await expect(
      frame.locator('[data-sender="customer"]').filter({ hasText: 'Kept for later' }),
    ).toHaveCount(1);
    await expect(
      frame.locator('[data-sender="customer"]').filter({ hasText: 'Take this back' }),
    ).toHaveCount(0);
    await expect(frame.getByTestId('delivery').last()).toHaveText('Sent');
  });
});

test.describe('history and read receipts (W05, W06)', () => {
  test('loads earlier messages, and counts replies that arrive while reading back', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let frame = await openWidget(page);
    await ask(frame, 'The very first question');
    await waitForAnswer(frame);
    const id = await conversationOf(frame);
    await staff('POST', `/v1/conversations/${id}/takeover`, {});
    for (let i = 1; i <= 55; i += 1) {
      await staff('POST', `/v1/conversations/${id}/messages`, {
        clientMessageId: randomUUID(),
        text: `Update ${i}`,
      });
    }
    await page.reload();
    await page.locator('[data-hamnivo-launcher]').click();
    frame = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(frame.getByText('Update 55')).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText('The very first question')).toHaveCount(0);
    await frame.getByTestId('older').click();
    await expect(frame.getByText('The very first question')).toBeVisible();
    await expect(frame.getByTestId('older')).toHaveCount(0);

    // Reading back: a new reply does not move the page, and a button says how many wait.
    const viewport = frame.locator('ul[aria-label="Chat"]').locator('xpath=..');
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await staff('POST', `/v1/conversations/${id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Update 56',
    });
    const pill = frame.getByTestId('jump-new');
    await expect(pill).toHaveText('New messages: 1', { timeout: 15_000 });
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(200);
    await pill.click();
    await expect(frame.getByText('Update 56', { exact: true })).toBeInViewport();
    await expect(pill).toHaveCount(0);
  });

  test('says why a message was not sent, and lets the visitor drop it', async ({ page }) => {
    const frame = await openWidget(page);
    await frame
      .getByTestId('file-input')
      .setInputFiles([{ name: 'expired.png', mimeType: 'image/png', buffer: PNG }]);
    await expect(frame.getByTestId('file-chips').getByRole('listitem')).toHaveAttribute(
      'data-state',
      'ready',
    );
    // The checked file is gone before the message goes (it waited too long).
    await asTenant(
      `UPDATE widget_uploads SET status = 'rejected', content = NULL, rejection_reason = 'unreadable'
        WHERE name = 'expired.png' AND status = 'available'`,
      [],
    );
    await ask(frame, 'Here is the photo');
    const failed = frame.locator('[data-sender="customer"][data-state="failed"]');
    await expect(failed).toContainText(
      'Not sent. A file in it can’t be sent any more. Edit the message and attach the file again.',
      { timeout: 20_000 },
    );
    await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Edit' })).toBeVisible();
    await audit(page);
    await failed.getByRole('button', { name: 'Remove' }).click();
    await expect(failed).toHaveCount(0);
    await expect(frame.getByText('Here is the photo')).toHaveCount(0);
  });

  test('marks a message read once Chatwoot says the team saw it', async ({ page }) => {
    test.setTimeout(120_000);
    const s = stack();
    const frame = await openWidget(page);
    await ask(frame, 'Is my refund approved?');
    await waitForAnswer(frame);
    const mine = frame.locator('[data-sender="customer"]').filter({ hasText: 'Is my refund' });
    await expect(mine.getByTestId('delivery')).toHaveText('Sent');
    const [control] = await asTenant<{ external: number }>(
      'SELECT external_conversation_id AS external FROM conversation_controls WHERE id = $1',
      [fromPublicId('conversation', await conversationOf(frame))],
    );
    const connections = await staff('GET', '/v1/admin/authority/connections');
    const accountId = connections.items[0].accountId as number;
    const agent = await provisionStaffUser({
      baseUrl: s.chatwootUrl,
      platformToken: s.chatwootPlatformToken,
      accountId,
      name: 'Team Member',
      email: `team-${randomUUID()}@example.com`,
      role: 'administrator',
    });
    // Chatwoot keeps whole seconds, and a look counts only if it came after the message: in the
    // same second it may have come first. Replies are quick enough now that the look would
    // otherwise land in the message's own second.
    await page.waitForTimeout(1100);
    const seen = await fetch(
      `${s.chatwootUrl}/api/v1/accounts/${accountId}/conversations/${control?.external}/update_last_seen`,
      { method: 'POST', headers: { api_access_token: agent.token } },
    );
    expect(seen.ok).toBe(true);
    // Looking sends no webhook: the worker's reconciler reads it on its next pass.
    await expect(mine.getByTestId('delivery')).toHaveText('Read', { timeout: 60_000 });
  });
});

test.describe('unread replies (W05)', () => {
  test('shows waiting replies on the launcher and marks where they start', async ({ page }) => {
    const frame = await openWidget(page);
    await ask(frame, 'Is anyone from the team there?');
    await waitForAnswer(frame);
    const conversationId = (await frame
      .locator('section[data-conversation-id]')
      .getAttribute('data-conversation-id')) as string;
    await page.keyboard.press('Escape');
    const launcher = page.locator('[data-hamnivo-launcher]');
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await staff('POST', `/v1/conversations/${conversationId}/takeover`, {});
    await staff('POST', `/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Yes, this is Sara. How can I help?',
    });
    await expect(page.locator('[data-hamnivo-unread]')).toHaveText(/^[1-9]$/, { timeout: 15_000 });
    await expect(launcher).toHaveAttribute('aria-label', /^Open chat, [1-9] unread$/);

    // Coming back later, the replies not seen yet start under a line.
    await page.reload();
    await launcher.click();
    const again = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(again.getByTestId('unread-divider')).toBeVisible();
    await expect(page.locator('[data-hamnivo-unread]')).toBeHidden();
    await expect(launcher).toHaveAttribute('aria-label', 'Close chat');
  });
});

test.describe('deleting and reacting (W22, W23)', () => {
  test('deletes one’s own message after asking, and reacts to a reply', async ({ page }) => {
    const frame = await openWidget(page);
    await ask(frame, 'Wrong window, sorry');
    await waitForAnswer(frame);
    const mine = frame.locator('[data-sender="customer"]').filter({ hasText: 'Wrong window' });
    await mine.getByRole('button', { name: 'Delete your message' }).click();
    await expect(frame.getByTestId('delete-confirm')).toContainText('Delete this message?');
    await frame.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(frame.getByTestId('message-deleted')).toHaveText('This message was deleted.');
    await expect(frame.getByText('Wrong window, sorry')).toHaveCount(0);

    const reply = frame.locator('[data-sender="ai_primary"]').last();
    await reply.getByRole('button', { name: 'React to this message' }).click();
    await reply.getByRole('button', { name: 'Thank you' }).click();
    await expect(frame.getByTestId('reaction').last()).toContainText('You reacted with Thank you');
    // "Helpful" is a reaction too: it shows on the reply it is for, and is given once.
    const helpful = reply.getByRole('button', { name: 'Helpful', exact: true });
    await helpful.click();
    await expect(reply.getByTestId('reaction')).toContainText([
      'You reacted with Thank you',
      'You reacted with Thumbs up',
    ]);
    await expect(helpful).toBeDisabled();
    await expect(helpful).toHaveAttribute('aria-pressed', 'true');
    await audit(page);
  });
});

test.describe('help before a conversation (W17)', () => {
  test.afterAll(async () => {
    await settings({});
  });

  test('offers the brand’s questions and searches its public help', async ({ page }) => {
    const s = stack();
    await settings({
      help: { suggestions: [{ en: 'Where is my order?', ar: 'أين طلبي؟' }], search: true },
    });
    const source = await staff('POST', '/v1/admin/knowledge/sources', {
      brandId: s.brandId,
      name: 'Help centre',
    });
    await staff('POST', `/v1/admin/knowledge/sources/${source.id}/documents`, {
      title: 'Returns policy',
      content: {
        mediaType: 'text/plain',
        text: 'Returns are accepted within 14 days of delivery with the receipt.',
      },
    });
    await expect
      .poll(
        async () =>
          (
            await staff('POST', '/v1/admin/knowledge/search', {
              query: 'returns',
              brandId: s.brandId,
            })
          ).items.length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    const frame = await openWidget(page);
    await expect(frame.getByTestId('suggestions')).toContainText('Where is my order?');
    const search = frame.getByRole('searchbox', { name: 'Search help articles' });
    await search.fill('returns');
    await search.press('Enter');
    const results = frame.getByTestId('help-results');
    await expect(results).toContainText('Returns policy');
    await expect(results).toContainText('within 14 days');
    await audit(page);
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    await expect(frame.getByTestId('suggestions')).toContainText('أين طلبي؟');
    await frame.getByRole('button', { name: 'أين طلبي؟' }).click();
    await expect(frame.locator('[data-sender="customer"]').last()).toContainText('أين طلبي؟');
  });
});

test.describe('website prompts (W19, G21)', () => {
  let automationId: string | null = null;
  /** One published website automation on /pricing, and the brand's daily limit. */
  const prompts = async (maxPerDay: number) => {
    await promptLimits({ maxPerDay, dismissHours: 24 });
    if (automationId) return;
    const created = await staff('POST', `/v1/admin/brands/${stack().brandId}/automations`, {
      name: 'Returns help',
      publish: true,
      definition: {
        event: { type: 'page_view', seconds: 1 },
        conditions: [{ field: 'page_url', op: 'starts_with', value: '/pricing' }],
        actions: [
          { type: 'show_prompt', message: { en: 'Questions about returns? Ask us here.' } },
        ],
      },
    });
    automationId = created.id as string;
  };
  test.afterAll(async () => {
    if (automationId) await staff('DELETE', `/v1/admin/automations/${automationId}`);
  });

  test('greets once a day on the chosen page, in the brand’s words', async ({ page }) => {
    await prompts(1);
    await page.goto(`${stack().hostUrl}/pricing`);
    const prompt = page.locator('[data-hamnivo-prompt]');
    await expect(prompt).toContainText('Questions about returns? Ask us here.', { timeout: 5_000 });
    await expect(prompt).toHaveAttribute('role', 'status');
    await expect(prompt.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    await prompt.getByRole('button', { name: 'Questions about returns? Ask us here.' }).click();
    await expect(prompt).toHaveCount(0);
    const frame = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(frame.getByTestId('proactive-greeting')).toHaveText(
      'Questions about returns? Ask us here.',
    );
    // The day's one prompt was shown: the next page view stays quiet.
    await page.goto(`${stack().hostUrl}/pricing`);
    await page.waitForTimeout(2_000);
    await expect(prompt).toHaveCount(0);
  });

  test('stays away elsewhere, and after a dismissal', async ({ page }) => {
    // Three a day are allowed here, so only the dismissal keeps the next one away.
    await prompts(3);
    await page.goto(`${stack().hostUrl}/about`);
    await page.waitForTimeout(2_000);
    await expect(page.locator('[data-hamnivo-prompt]')).toHaveCount(0);
    await page.goto(`${stack().hostUrl}/pricing/plans`);
    const prompt = page.locator('[data-hamnivo-prompt]');
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(2_000);
    await expect(prompt).toHaveCount(0);
  });

  test('never covers an open chat', async ({ page }) => {
    await prompts(3);
    await page.goto(`${stack().hostUrl}/pricing`);
    await page.locator('[data-hamnivo-launcher]').click();
    await page.waitForTimeout(2_000);
    await expect(page.locator('[data-hamnivo-prompt]')).toHaveCount(0);
  });
});

test.describe('layouts (W02)', () => {
  test('a side panel, inline in the page, and the whole page', async ({ page }) => {
    const { hostUrl } = stack();
    const viewport = page.viewportSize() as { width: number; height: number };
    await page.goto(`${hostUrl}/panel.html`);
    await page.locator('[data-hamnivo-launcher]').click();
    const panel = page.locator('iframe[data-hamnivo-frame]');
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.height).toBeCloseTo(viewport.height, -1);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(viewport.width, -1);

    await page.goto(`${hostUrl}/inline.html`);
    await expect(page.locator('[data-hamnivo-launcher]')).toHaveCount(0);
    const inline = page.locator('#chat iframe[data-hamnivo-frame]');
    await expect(inline).toBeVisible();
    await expect(page.frameLocator('#chat iframe').getByTestId('greeting')).toBeVisible();
    await expect(
      page.frameLocator('#chat iframe').getByRole('button', { name: 'Close chat' }),
    ).toHaveCount(0);

    await page.goto(`${hostUrl}/fullpage.html`);
    const full = page.locator('iframe[data-hamnivo-frame]');
    await expect(full).toBeVisible();
    const whole = await full.boundingBox();
    expect(whole).toMatchObject({ x: 0, y: 0 });
    expect(whole?.width).toBeCloseTo(viewport.width, -1);
  });

  test('display settings: larger text and less motion, and the device’s own choice', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    let frame = await openWidget(page);
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Settings' }).click();
    await frame.getByRole('radio', { name: 'Larger' }).check();
    await expect(frame.locator('html')).toHaveCSS('font-size', '20px');
    await frame.getByRole('checkbox', { name: 'Reduce motion' }).check();
    await expect(frame.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await audit(page);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    frame = await openWidget(page);
    await expect(frame.locator('html')).toHaveCSS('font-size', '20px');
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Settings' }).click();
    const motion = frame.getByRole('checkbox', { name: 'Reduce motion' });
    await expect(motion).toBeChecked();
    await expect(motion).toBeDisabled();
    await expect(frame.getByTestId('settings')).toContainText('Your device asks for less motion');
  });

  test('works with the keyboard alone', async ({ page }) => {
    await page.goto(stack().hostUrl);
    const launcher = page.locator('[data-hamnivo-launcher]');
    await expect(launcher).toBeVisible();
    // From the top of the page to the launcher with Tab.
    for (
      let i = 0;
      // The launcher is in a shadow root: the page's own activeElement is the root around it.
      i < 10 &&
      !(await launcher.evaluate(
        (el) => el === (el.getRootNode() as Document | ShadowRoot).activeElement,
      ));
      i += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(launcher).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    const frame = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(frame.getByTestId('greeting')).toBeVisible();
    // Into the chat and to its settings without a mouse.
    const tabTo = async (role: 'button' | 'radio', name: string) => {
      const target = frame.getByRole(role, { name, exact: true });
      for (let i = 0; i < 30; i += 1) {
        if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
        await page.keyboard.press('Tab');
      }
      throw new Error(`${name} never got focus`);
    };
    await tabTo('button', 'More options');
    await page.keyboard.press('Enter');
    await tabTo('button', 'Settings');
    await page.keyboard.press('Enter');
    await expect(frame.getByTestId('settings')).toBeVisible();
    await tabTo('radio', 'Normal');
    await page.keyboard.press('ArrowRight');
    await expect(frame.getByRole('radio', { name: 'Large', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await expect(launcher).toBeFocused();
  });
});

test.describe('on a phone (W02, W14)', () => {
  test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

  test('opens full screen at 320 px, nothing overflows, in English and Arabic', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    const box = await page.locator('iframe[data-hamnivo-frame]').boundingBox();
    expect(box?.width).toBeCloseTo(320, 0);
    await fits(frame);
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Settings' }).click();
    await fits(frame);
    await frame.getByRole('button', { name: 'Back to chat' }).click();
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    await fits(frame);
    await audit(page);
  });
});

test.describe('at 200 % zoom (W02, W14)', () => {
  // A 390 px phone zoomed to 200 % lays out 195 CSS pixels.
  test.use({ viewport: { width: 195, height: 422 } });

  test('still reflows and sends with larger text', async ({ page }) => {
    const frame = await openWidget(page);
    await fits(frame);
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Settings' }).click();
    await frame.getByRole('radio', { name: 'Larger' }).check();
    await frame.getByRole('button', { name: 'Back to chat' }).click();
    await fits(frame);
    await ask(frame, 'Zoomed in');
    await fits(frame);
  });
});

test.describe('signed-in customers (W18, W25)', () => {
  async function device(context: BrowserContext) {
    const page = await context.newPage();
    const frame = await openWidget(page);
    return { page, frame };
  }

  test('continue on another device, and choose emails there', async ({ browser }) => {
    const id = `amina-${randomUUID().slice(0, 8)}`;
    const phone = await browser.newContext();
    const laptop = await browser.newContext();
    try {
      const a = await device(phone);
      await signIn(a.page, { id, email: `${id}@example.com` });
      await ask(a.frame, 'I ordered the blue kettle on my phone');
      await waitForAnswer(a.frame);

      const b = await device(laptop);
      await expect(b.frame.getByText('I ordered the blue kettle on my phone')).toHaveCount(0);
      await signIn(b.page, { id, email: `${id}@example.com` });
      await expect(b.frame.getByText('I ordered the blue kettle on my phone')).toBeVisible();

      await b.frame.getByRole('button', { name: 'More options' }).click();
      await b.frame.getByRole('button', { name: 'Settings' }).click();
      const emails = b.frame.getByTestId('email-settings');
      await expect(emails).toContainText(`Sent to a•••@example.com.`);
      const transcript = emails.getByRole('checkbox', {
        name: 'Send me a copy when a conversation closes',
      });
      await transcript.check();
      await expect(transcript).toBeChecked();
      await audit(b.page);
    } finally {
      await phone.close();
      await laptop.close();
    }
  });

  test('anonymous visitors are told how to get emails', async ({ page }) => {
    const frame = await openWidget(page);
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Settings' }).click();
    await expect(frame.getByTestId('email-settings')).toContainText(
      'Sign in on the website to get emails about your conversations.',
    );
    await expect(frame.getByTestId('email-settings').getByRole('checkbox')).toHaveCount(0);
  });
});

test.describe('contact form and tickets (W11, H19)', () => {
  test.beforeAll(async () => {
    await widgetForms({
      offline: {
        enabled: true,
        when: 'either',
        thanks: { en: 'We read every message within a day.' },
      },
    });
  });
  test.afterAll(async () => {
    await widgetForms({});
  });

  test('leaves a message while nobody can answer, and follows the ticket it becomes', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const frame = await openWidget(page);
    // Nobody from the team is online in this stack, and the brand has set no business hours.
    await expect(frame.getByTestId('availability')).toHaveText(
      'Nobody is online right now. Your message will wait for a person.',
    );
    const card = frame.getByTestId('contact-card');
    await expect(card).toContainText('Nobody can answer right now');
    await expect(card).toContainText('Leave a message and we’ll answer by email.');
    // The assistant may still answer, so the message box stays.
    await expect(textbox(frame)).toBeVisible();
    await audit(page);

    await card.getByRole('button', { name: 'Leave a message' }).click();
    const form = frame.getByTestId('contact-form');
    await expect(form.getByRole('heading', { name: 'Leave a message' })).toBeFocused();
    // Mistakes are listed at the top, each on its field, and the first one gets focus.
    await form.getByRole('button', { name: 'Send message' }).click();
    const summary = form.locator('[data-slot="form-error-summary"]');
    await expect(summary).toContainText('Check these answers');
    await expect(summary).toContainText('Your email: Fill this in.');
    await expect(summary).toContainText('How can we help?: Fill this in.');
    const email = form.getByRole('textbox', { name: 'Your email (required)', exact: true });
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toHaveAttribute('autocomplete', 'email');
    await audit(page);
    await email.fill('amina@example');
    const question = 'Can I change the address on order 1042?';
    await form.getByRole('textbox', { name: 'How can we help? (required)' }).fill(question);
    await form.getByRole('button', { name: 'Send message' }).click();
    await expect(summary).toContainText('Enter an email address like name@example.com.');
    await email.fill(`amina-${randomUUID().slice(0, 8)}@example.com`);
    await form.getByRole('textbox', { name: 'Your name', exact: true }).fill('Amina Noor');
    await form.getByRole('button', { name: 'Send message' }).click();

    const thanks = frame.getByTestId('ticket-thanks');
    await expect(thanks.getByRole('heading', { name: 'Message sent' })).toBeFocused();
    const said = thanks.getByTestId('ticket-reference');
    await expect(said).toHaveText(/^Your reference is #\d+\.$/);
    const reference = ((await said.textContent()) ?? '').match(/#\d+/)?.[0] as string;
    await expect(thanks).toContainText('We read every message within a day.');
    await expect(thanks).toContainText(
      /We sent a link to \S+@example\.com\. Open it so we can send our answer there\./,
    );
    await audit(page);

    // The ticket is one of the customer's conversations, with its reference and state.
    await thanks.getByRole('button', { name: 'Back to start' }).click();
    await expect(frame.getByTestId('home')).toBeVisible();
    await frame.getByRole('button', { name: 'More options' }).click();
    await frame.getByRole('button', { name: 'Your conversations' }).click();
    const item = frame.getByTestId('conversation-item').filter({ hasText: reference });
    await expect(item).toContainText(`Ticket ${reference} · Open`);
    await item.click();
    await expect(frame.getByTestId('header-ticket')).toHaveText(`Ticket ${reference} · Open`);
    await expect(frame.getByText(question).first()).toBeVisible();

    // The team sees it as a ticket from the contact form, and waits for the customer's answer.
    const id = await conversationOf(frame);
    const detail = await staff('GET', `/v1/inbox/conversations/${id}`);
    expect(detail.ticket).toMatchObject({ reference, state: 'open', source: 'offline_form' });
    await staff('POST', `/v1/inbox/conversations/${id}/status`, { status: 'snoozed' });
    const again = await openWidget(page);
    await expect(again.getByTestId('header-ticket')).toHaveText(
      `Ticket ${reference} · Waiting for your reply`,
      { timeout: 15_000 },
    );
  });

  test.describe('on a phone, in Arabic', () => {
    test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

    test('the form fits at 320 px and reads right to left', async ({ page }) => {
      const frame = await openWidget(page);
      await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
      await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
      await frame.getByTestId('contact-card').getByRole('button', { name: 'اترك رسالة' }).click();
      const form = frame.getByTestId('contact-form');
      await form.getByRole('button', { name: 'أرسل الرسالة' }).click();
      await expect(form.locator('[data-slot="form-error-summary"]')).toContainText(
        'راجع هذه الإجابات',
      );
      await fits(frame);
      await audit(page);
    });
  });
});

test.describe('pre-chat form (W26)', () => {
  test.beforeAll(async () => {
    await widgetForms({
      prechat: {
        enabled: true,
        skipVerified: true,
        fields: [
          { id: 'name', kind: 'name', label: { en: 'Your name', ar: 'اسمك' }, required: true },
          { id: 'order', kind: 'text', label: { en: 'Order number' }, required: false },
          { id: 'question', kind: 'question', label: { en: 'How can we help?' }, required: true },
        ],
      },
      // The contact form stays out of the way here.
      offline: { enabled: false },
    });
  });
  test.afterAll(async () => {
    await widgetForms({});
  });

  test('asks before the first message, keeps what was written, then starts with it', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await textbox(frame).fill('Where is my order?');
    await textbox(frame).press('Enter');
    const gate = frame.getByTestId('prechat');
    await expect(gate.getByRole('heading', { name: 'Before we start' })).toBeFocused();
    // The question starts with what the visitor wrote; nothing was sent yet.
    await expect(gate.getByRole('textbox', { name: 'How can we help? (required)' })).toHaveValue(
      'Where is my order?',
    );
    await expect(frame.locator('[data-sender="customer"]')).toHaveCount(0);
    await audit(page);
    await gate.getByRole('button', { name: 'Start chat' }).click();
    await expect(gate.locator('[data-slot="form-error-summary"]')).toContainText(
      'Your name: Fill this in.',
    );
    const name = gate.getByRole('textbox', { name: 'Your name (required)' });
    await expect(name).toBeFocused();
    // "Not now" gives the words back to the message box.
    await gate.getByRole('button', { name: 'Not now' }).click();
    await expect(textbox(frame)).toHaveValue('Where is my order?');
    await textbox(frame).press('Enter');
    await name.fill('Amina Noor');
    await gate.getByRole('textbox', { name: 'Order number' }).fill('1042');
    await gate.getByRole('button', { name: 'Start chat' }).click();
    await expect(gate).toHaveCount(0);
    await expect(frame.locator('[data-sender="customer"]').last()).toContainText(
      'Where is my order?',
    );
    await waitForAnswer(frame);
    // The next message goes straight on: the form is asked once.
    await ask(frame, 'Thank you');
    await expect(gate).toHaveCount(0);
  });

  test('lets a customer the website signed in go straight in', async ({ page }) => {
    const frame = await openWidget(page);
    await signIn(page, { id: `amina-${randomUUID().slice(0, 8)}` });
    await ask(frame, 'Signed in, so no form');
    await expect(frame.getByTestId('prechat')).toHaveCount(0);
  });
});

test.describe('consent (W27)', () => {
  test.afterAll(async () => {
    await consentSettings({ mode: 'off' });
  });

  test('asks before the first message, never ticked in advance, then sends it', async ({
    page,
  }) => {
    await consentSettings({
      mode: 'everyone',
      text: { en: 'We keep this chat for 30 days to help you. Ask us to delete it at any time.' },
    });
    const frame = await openWidget(page);
    await textbox(frame).fill('Is the shop open on Friday?');
    await textbox(frame).press('Enter');
    const card = frame.getByTestId('consent-card');
    await expect(card).toContainText('We keep this chat for 30 days to help you.');
    await expect(card.getByTestId('pending-message')).toHaveText('Is the shop open on Friday?');
    const agree = card.getByRole('checkbox', { name: 'I agree' });
    await expect(agree).not.toBeChecked();
    await audit(page);
    await card.getByRole('button', { name: 'Continue' }).click();
    await expect(card).toContainText('Tick “I agree” to continue.');
    await expect(agree).toBeFocused();
    await agree.check();
    await card.getByRole('button', { name: 'Continue' }).click();
    await expect(card).toHaveCount(0);
    await expect(frame.locator('[data-sender="customer"]').last()).toContainText(
      'Is the shop open on Friday?',
    );
    await waitForAnswer(frame);
  });

  test('is not asked when the brand does not ask for it', async ({ page }) => {
    await consentSettings({ mode: 'off' });
    const frame = await openWidget(page);
    await ask(frame, 'No consent asked here');
    await expect(frame.getByTestId('consent-card')).toHaveCount(0);
  });
});

test.describe('direct chat link (W28)', () => {
  test.afterAll(async () => {
    await directLink({ enabled: false });
  });

  test('opens the chat on its own page, out of search results, and closes with the link', async ({
    page,
  }) => {
    const s = stack();
    const link = await directLink({ enabled: true });
    const url = (link.url as string | null) ?? `${s.widgetOrigin}/c/${s.widgetId}`;
    // The widget reads its id from this path.
    expect(new URL(url).pathname).toBe(`/c/${s.widgetId}`);
    // Production builds name the gateway (VITE_HAMNIVO_API); this test build is told it here.
    const opened = `${url}?api=${encodeURIComponent(s.apiBase)}`;
    await page.goto(opened);
    await expect(page.getByTestId('ai-disclosure')).toBeVisible();
    await expect(page).toHaveTitle('Noor Books');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.getByRole('heading', { level: 1, name: 'Noor Books' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Language' })).toBeVisible();
    // No website around it: nothing to close back to.
    await expect(page.getByRole('button', { name: 'Close chat' })).toHaveCount(0);
    await audit(page, { frame: false });
    const box = page.getByRole('textbox', { name: 'Write a message…' });
    await box.fill('Hello from the link');
    await box.press('Enter');
    await expect(page.locator('[data-sender="customer"]').last()).toContainText(
      'Hello from the link',
    );
    await expect(page.locator('[data-sender="ai_primary"]').last()).toBeVisible({
      timeout: 20_000,
    });

    // Turned off, the link opens no chat.
    await directLink({ enabled: false });
    await page.reload();
    await expect(page.getByRole('alert')).toHaveText('The chat could not start. Please try again.');
  });
});

test.describe('reopen (W15)', () => {
  test('“I still need help” opens a closed conversation again', async ({ page }) => {
    const frame = await openWidget(page);
    await ask(frame, 'Thanks, that answers it');
    await waitForAnswer(frame);
    const id = await conversationOf(frame);
    await staff('POST', `/v1/inbox/conversations/${id}/status`, { status: 'resolved' });
    const banner = frame.getByTestId('status-banner');
    await expect(banner).toHaveText('This conversation is closed. Write to reopen it.', {
      timeout: 15_000,
    });
    await audit(page);
    await frame.getByRole('button', { name: 'I still need help' }).click();
    await expect(banner).toHaveCount(0);
    await expect(textbox(frame)).toBeFocused();
    await expect
      .poll(async () => (await staff('GET', `/v1/inbox/conversations/${id}`)).status, {
        timeout: 15_000,
      })
      .not.toBe('resolved');
  });
});

test.describe('chat that isn’t available (H20)', () => {
  test('a blocked visitor reads only that chat isn’t available, can still read, and chats again once unblocked', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const frame = await openWidget(page);
    await ask(frame, 'You are all useless, answer me now');
    await waitForAnswer(frame);
    const id = await conversationOf(frame);
    // The team blocks the visitor from the chat, as Studio does, and leaves the chat open.
    const block = (await staff('POST', `/v1/inbox/conversations/${id}/block`, {
      reason: 'Abusive messages',
      duration: 'day',
      closeChat: false,
    })) as { id: string; active: boolean };
    expect(block.active).toBe(true);

    // The next message is refused: the chat says chat isn't available, without an error or why.
    await textbox(frame).fill('Hello? Anyone?');
    await textbox(frame).press('Enter');
    const notice = frame.getByTestId('chat-unavailable');
    await expect(notice).toHaveText('Chat isn’t available right now.');
    await expect(frame.getByRole('alert').filter({ hasText: 'Not sent.' })).toContainText(
      'Not sent. Chat isn’t available right now.',
    );
    await expect(textbox(frame)).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Talk to a person' })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(frame.locator('body')).not.toContainText(/block/i);
    // The gateway refused it: the team never receives it.
    const seen = await staff('GET', `/v1/inbox/conversations/${id}/messages`);
    expect(JSON.stringify(seen)).toContain('You are all useless, answer me now');
    expect(JSON.stringify(seen)).not.toContain('Hello? Anyone?');
    await audit(page);
    // The visitor drops the message that wasn't sent.
    await frame.getByRole('button', { name: 'Remove' }).click();
    await expect(frame.getByText('Hello? Anyone?')).toHaveCount(0);

    // On the next visit the session says so at once; the conversation can still be read.
    const again = await openWidget(page);
    await expect(again.getByTestId('chat-unavailable')).toHaveText(
      'Chat isn’t available right now.',
    );
    await expect(again.getByText('You are all useless, answer me now').first()).toBeVisible();
    await expect(textbox(again)).toHaveCount(0);
    await expect(again.locator('body')).not.toContainText(/block/i);
    await audit(page);

    // Unblocked, the visitor can chat again.
    await staff('DELETE', `/v1/visitors/blocks/${block.id}`);
    const after = await openWidget(page);
    await expect(textbox(after)).toBeVisible();
    await expect(after.getByTestId('chat-unavailable')).toHaveCount(0);
    await ask(after, 'Sorry about earlier');
  });
});
