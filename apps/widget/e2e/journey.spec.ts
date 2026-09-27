import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';

interface Stack {
  hostUrl: string;
  apiBase: string;
  widgetOrigin: string;
  consoleOrigin: string;
  widgetId: string;
  tenantId: string;
  cookie: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

async function staff(method: string, path: string, body: unknown) {
  const s = stack();
  const response = await fetch(`${s.apiBase}${path}`, {
    method,
    headers: {
      origin: s.consoleOrigin,
      cookie: s.cookie,
      'x-hamnivo-tenant': s.tenantId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

async function openWidget(page: Page, path = '/'): Promise<FrameLocator> {
  await page.goto(`${stack().hostUrl}${path}`);
  const launcher = page.locator('[data-hamnivo-launcher]');
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  return page.frameLocator('iframe[data-hamnivo-frame]');
}

test.describe('Hamnivo Chat on a customer website', () => {
  test('host page → widget → AI reply → staff takeover → human reply', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).origin + new URL(r.url()).pathname));
    await page.goto(stack().hostUrl);
    await expect(page.locator('[data-hamnivo-launcher]')).toBeVisible();
    // Before the visitor opens the chat, only the loader script is fetched from the widget origin.
    expect(requests.filter((u) => u.startsWith(stack().widgetOrigin))).toEqual([
      `${stack().widgetOrigin}/loader.js`,
    ]);
    await expect(page.locator('iframe[data-hamnivo-frame]')).toHaveCount(0);

    await page.locator('[data-hamnivo-launcher]').click();
    const frame = page.frameLocator('iframe[data-hamnivo-frame]');
    await expect(frame.getByTestId('ai-disclosure')).toContainText("Noor Books's AI assistant");
    await expect(frame.getByTestId('greeting')).toBeVisible();

    const input = frame.getByRole('textbox', { name: 'Write a message…' });
    await input.fill('Assalamu alaikum, where is my order?');
    await input.press('Enter');
    await expect(frame.locator('[data-sender="customer"]').last()).toContainText(
      'where is my order',
    );
    const reply = frame.locator('[data-sender="ai_primary"]').last();
    await expect(reply).toContainText('Wa alaikum assalam!', { timeout: 20_000 });
    await expect(reply).toContainText('AI assistant');

    const conversationId = await frame
      .locator('section[data-conversation-id]')
      .getAttribute('data-conversation-id');
    expect(conversationId).toMatch(/^conv_/);
    await staff('POST', `/v1/conversations/${conversationId}/takeover`, {});
    await expect(frame.getByTestId('status-banner')).toContainText('chatting with a person', {
      timeout: 15_000,
    });
    await staff('POST', `/v1/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Wa alaikum assalam, this is Sara from the team. Your parcel ships today.',
    });
    const human = frame.locator('[data-sender="human_agent"]').last();
    await expect(human).toContainText('Your parcel ships today', { timeout: 15_000 });
    await expect(human).toContainText('Support agent');
    await expect(frame.getByRole('button', { name: 'Talk to a person' })).toHaveCount(0);

    // Closing with Escape returns focus to the launcher.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-hamnivo-launcher]')).toHaveAttribute('aria-expanded', 'false');
  });

  test('a message typed while offline is sent once when the connection returns', async ({
    page,
    context,
  }) => {
    const frame = await openWidget(page);
    const input = frame.getByRole('textbox', { name: 'Write a message…' });
    await input.fill('First question');
    await input.press('Enter');
    await expect(frame.locator('[data-sender="ai_primary"]').last()).toBeVisible({
      timeout: 20_000,
    });
    await context.setOffline(true);
    await input.fill('Sent while offline');
    await input.press('Enter');
    await expect(
      frame.locator('[data-state="queued"], [data-state="sending"]').last(),
    ).toContainText('Sent while offline');
    await context.setOffline(false);
    await expect(
      frame.locator('[data-sender="customer"][data-state="accepted"]').last(),
    ).toContainText('Sent while offline', {
      timeout: 30_000,
    });
    await expect(
      frame.locator('[data-sender="customer"]').filter({ hasText: 'Sent while offline' }),
    ).toHaveCount(1);
  });

  test('Arabic and Urdu read right to left, and the widget passes an accessibility audit', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(frame.getByRole('button', { name: 'إرسال' })).toBeVisible();
    await frame.getByRole('combobox', { name: 'اللغة' }).selectOption('ur');
    await expect(frame.locator('html')).toHaveAttribute('lang', 'ur');
    await frame.getByRole('combobox', { name: 'زبان' }).selectOption('en');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'ltr');

    const results = await new AxeBuilder({ page })
      .include('iframe[data-hamnivo-frame]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([]);
  });

  test('refuses to run on a website the brand did not allow', async ({ page }) => {
    const s = stack();
    await page.goto(
      `${s.widgetOrigin}/?widgetId=${s.widgetId}&host=${encodeURIComponent('https://evil.example')}&api=${encodeURIComponent(s.apiBase)}`,
    );
    await expect(page.getByRole('alert')).toContainText('could not start');
  });
});
