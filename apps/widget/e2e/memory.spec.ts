/**
 * Customer memory in the widget (L04, G19; board 15: HNV-15-01 to 15-06): the memory question,
 * "What we remember" with corrections and deletions, the memory switch and right-to-left layout.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';

interface Stack {
  hostUrl: string;
  apiBase: string;
  consoleOrigin: string;
  tenantId: string;
  cookie: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

async function staff<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

/** Turns memory on or off for the brand's assistant and publishes it. */
async function useMemory(enabled: boolean) {
  const agents = await staff<{ items: Array<{ id: string }> }>('GET', '/v1/admin/agents');
  const id = agents.items[0]?.id;
  const detail = await staff<{
    published: { config: Record<string, unknown> & { memory?: object } };
  }>('GET', `/v1/admin/agents/${id}`);
  const config = detail.published.config;
  await staff('PUT', `/v1/admin/agents/${id}/draft`, {
    config: { ...config, memory: { ...config.memory, enabled } },
  });
  await staff('POST', `/v1/admin/agents/${id}/publish`, {});
}

async function openWidget(page: Page): Promise<FrameLocator> {
  await page.goto(stack().hostUrl);
  const launcher = page.locator('[data-hamnivo-launcher]');
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  return page.frameLocator('iframe[data-hamnivo-frame]');
}

async function ask(frame: FrameLocator, text: string) {
  const replies = await frame.locator('[data-sender="ai_primary"]').count();
  const input = frame.getByRole('textbox', { name: 'Write a message…' });
  await input.fill(text);
  await input.press('Enter');
  await expect(frame.locator('[data-sender="ai_primary"]')).toHaveCount(replies + 1, {
    timeout: 20_000,
  });
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('iframe[data-hamnivo-frame]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

test.describe('customer memory in the widget', () => {
  test.beforeAll(() => useMemory(true));
  test.afterAll(() => useMemory(false));

  test('HNV-15-01 HNV-15-02 HNV-15-03 HNV-15-04 HNV-15-05 · agree, see what is remembered and why, confirm, correct and delete it, turn memory off', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    const consent = frame.getByTestId('memory-consent');
    await expect(consent).toBeVisible();
    await expect(consent).toContainText('never remembers health, religion, passwords');
    // Two equal answers and nothing chosen for the customer.
    await expect(consent.getByRole('button', { name: 'Yes, remember' })).toBeVisible();
    await expect(consent.getByRole('button', { name: 'No, thanks' })).toBeVisible();
    expect(await audit(page)).toEqual([]);
    await consent.getByRole('button', { name: 'Yes, remember' }).click();
    await expect(consent).toBeHidden();

    await ask(frame, 'Please answer in Urdu from now on.');
    const open = frame.getByRole('button', { name: 'Memory', exact: true });
    const panel = frame.getByTestId('memory-panel');
    const language = panel.locator('[data-memory="preferred_language"][data-status="active"]');
    // Remembering runs in the background after the reply: reopen the view until it shows.
    const reopenUntil = (check: () => Promise<void>) =>
      expect(async () => {
        if (await panel.isVisible())
          await panel.getByRole('button', { name: 'Back to chat' }).click();
        await open.click();
        await check();
      }).toPass({ timeout: 20_000 });
    await reopenUntil(() => expect(language).toContainText('Urdu', { timeout: 1000 }));
    await expect(language).toContainText('From your message on');
    await expect(language).toContainText('Kept until');

    // G19: a later answer that uses the memory says so, and links to it.
    await panel.getByRole('button', { name: 'Back to chat' }).click();
    await ask(frame, 'Where is my parcel?');
    const note = frame.getByTestId('memory-note').last();
    await expect(note).toContainText('Based on what you told us before: Preferred language.');
    await expect(frame.locator('[data-sender="ai_primary"]').last()).not.toContainText('[M1]');
    await note.getByRole('button', { name: 'See what we remember' }).click();
    await expect(panel).toBeVisible();
    expect(await audit(page)).toEqual([]);

    // HNV-15-03: saying something different asks the customer to confirm it first.
    await panel.getByRole('button', { name: 'Back to chat' }).click();
    await ask(frame, 'Actually, please answer in English.');
    const review = panel.locator('[data-memory="preferred_language"][data-status="pending"]');
    await reopenUntil(() => expect(review).toContainText('English', { timeout: 1000 }));
    await expect(review).toContainText('Before, we had: Urdu.');
    expect(await audit(page)).toEqual([]);
    await review.getByRole('button', { name: 'Yes, use this' }).click();
    await expect(review).toHaveCount(0);
    await expect(language).toContainText('English');

    // HNV-15-04: a correction replaces the value; the old one is no longer used.
    await language.getByRole('button', { name: 'Correct Preferred language' }).click();
    await language.getByLabel('New value for Preferred language').fill('Arabic');
    await language.getByRole('button', { name: 'Save' }).click();
    await expect(language).toContainText('Arabic');
    await expect(language).toContainText('Set by you on');

    // HNV-15-05: deleted at once, then removed everywhere once indexes and caches are cleared.
    await language.getByRole('button', { name: 'Delete Preferred language' }).click();
    await language.getByRole('button', { name: 'Yes, delete' }).click();
    const receipt = panel.getByTestId('memory-receipt').first();
    await expect(receipt).toContainText('Deleted. It’s no longer used.');
    await expect(receipt).toHaveAttribute('data-status', 'completed', { timeout: 20_000 });
    await expect(receipt).toContainText('Removed everywhere.');
    await expect(panel.getByTestId('memory-empty')).toBeVisible();

    // The switch turns memory off; nothing new is remembered.
    const memorySwitch = panel.getByRole('switch', { name: 'Remember my preferences' });
    await expect(memorySwitch).toHaveAttribute('aria-checked', 'true');
    await memorySwitch.click();
    await expect(memorySwitch).toHaveAttribute('aria-checked', 'false');
    await expect(panel).toContainText('Off. Nothing new is remembered');
    expect(await audit(page)).toEqual([]);
  });

  test('HNV-15-06 · says when memory is unavailable, and the chat keeps working', async ({
    page,
  }) => {
    let failing = true;
    await page.route('**/v1/widget/memory', (route) =>
      failing
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 503, code: 'UNAVAILABLE', retryable: true }),
          })
        : route.fallback(),
    );
    const frame = await openWidget(page);
    await frame.getByRole('button', { name: 'Memory', exact: true }).click();
    const panel = frame.getByTestId('memory-panel');
    await expect(panel.getByTestId('memory-unavailable')).toContainText(
      'Memory isn’t available right now. Your chat still works.',
    );
    expect(await audit(page)).toEqual([]);
    failing = false;
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByTestId('memory-unavailable')).toHaveCount(0);
    await expect(panel.getByRole('switch', { name: 'Remember my preferences' })).toBeVisible();
    await panel.getByRole('button', { name: 'Back to chat' }).click();
    await ask(frame, 'Where is my parcel?');
  });

  test('HNV-15-01 · the memory question and the memory view read right to left in Urdu and Arabic', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ur');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    const consent = frame.getByTestId('memory-consent');
    await expect(consent.getByRole('heading', { name: 'آپ کی پسند یاد رکھیں؟' })).toBeVisible();
    expect(await audit(page)).toEqual([]);
    // Deciding later asks again next time; nothing is remembered meanwhile.
    await consent.getByRole('button', { name: 'بعد میں فیصلہ کریں' }).click();
    await expect(consent).toBeHidden();

    await frame.getByRole('button', { name: 'میموری', exact: true }).click();
    const panel = frame.getByTestId('memory-panel');
    await expect(panel.getByRole('heading', { name: 'ہم کیا یاد رکھتے ہیں' })).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'میری پسند یاد رکھیں' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(await audit(page)).toEqual([]);

    await frame.getByRole('combobox', { name: 'زبان' }).selectOption('ar');
    await expect(panel.getByRole('heading', { name: 'ما نتذكره' })).toBeVisible();
    await panel.getByRole('switch', { name: 'تذكّر تفضيلاتي' }).click();
    await expect(panel.getByRole('switch', { name: 'تذكّر تفضيلاتي' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(panel).toContainText('مفعّلة.');
    expect(await audit(page)).toEqual([]);
  });
});
