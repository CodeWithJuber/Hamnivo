import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { provisionStaffUser } from '@hamnivo/chatwoot';
import { createDb, fromPublicId } from '@hamnivo/db';
import { createIdentityAssertion } from '@hamnivo/server';
import { type BrowserContext, expect, type FrameLocator, type Page, test } from '@playwright/test';

/**
 * The customer surface in a browser (W02, W05–W07, W09, W11, W14, W17–W19, W22–W25), on the
 * stack from e2e/stack.ts: a host page on another origin, the loader, the widget and the gateway.
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
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  expect(response.ok, `${method} ${path} → ${response.status} ${JSON.stringify(json)}`).toBe(true);
  return json;
}

const settings = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/widget-settings`, body);
const proactive = (body: unknown) =>
  staff('PUT', `/v1/admin/brands/${stack().brandId}/proactive`, body);

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

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('iframe[data-hamnivo-frame]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
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

test.describe('proactive prompts (W19)', () => {
  const prompts = (maxPerDay: number) =>
    proactive({
      enabled: true,
      maxPerDay,
      dismissHours: 24,
      triggers: [
        {
          id: 'pricing',
          kind: 'page_path',
          path: '/pricing',
          seconds: 1,
          message: { en: 'Questions about returns? Ask us here.' },
        },
      ],
    });
  test.afterAll(async () => {
    await proactive({ enabled: false });
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
      i < 10 && !(await launcher.evaluate((el) => el === document.activeElement));
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
