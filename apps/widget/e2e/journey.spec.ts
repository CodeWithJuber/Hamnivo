import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { createIdentityAssertion } from '@hamnivo/server';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';

interface Stack {
  hostUrl: string;
  apiBase: string;
  widgetOrigin: string;
  consoleOrigin: string;
  widgetId: string;
  tenantId: string;
  cookie: string;
  identityKey: { kid: string; secret: string };
}

/** The loader's public API on the host page. */
type HostApi = { identify(assertion: string): Promise<void>; reset(): Promise<void> };

/** Signs `customerId` in on `page`, as the website does with an assertion from its server. */
async function signIn(page: Page, customerId: string) {
  const s = stack();
  const assertion = await createIdentityAssertion({
    widgetId: s.widgetId,
    key: { kid: s.identityKey.kid, alg: 'HS256', secret: s.identityKey.secret },
    customer: { id: customerId, name: 'Fatima Noor' },
  });
  await page.evaluate(
    (signed) => (window as unknown as { Hamnivo: HostApi }).Hamnivo.identify(signed),
    assertion,
  );
}

/** The website signs the customer out. */
const signOut = (page: Page) =>
  page.evaluate(() => (window as unknown as { Hamnivo: HostApi }).Hamnivo.reset());

async function ask(frame: FrameLocator, text: string) {
  const input = frame.getByRole('textbox', { name: 'Write a message…' });
  await input.fill(text);
  await input.press('Enter');
  await expect(frame.locator('[data-sender="customer"]').last()).toContainText(text);
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

  test('W12 · a signed-in customer sees their own chat, and signing out on the website clears it', async ({
    page,
  }) => {
    const s = stack();
    const customerId = `fatima-${randomUUID().slice(0, 8)}`;
    const question = 'My order 1042 has not arrived yet';

    let frame = await openWidget(page);
    await signIn(page, customerId);
    await ask(frame, question);
    await expect(frame.locator('[data-sender="ai_primary"]').last()).toBeVisible({
      timeout: 20_000,
    });

    const widget = page.frames().find((f) => f.url().startsWith(s.widgetOrigin));
    if (!widget) throw new Error('widget frame not found');
    const refreshKey = `hamnivo:${s.widgetId}:refresh`;
    const signedInToken = await widget.evaluate((key) => localStorage.getItem(key), refreshKey);
    expect(signedInToken).toBeTruthy();

    // The website signs the customer out: their chat leaves the screen and the device at once.
    await signOut(page);
    await expect(frame.getByText(question)).toHaveCount(0);
    await expect(frame.getByTestId('greeting')).toBeVisible();
    const afterReset = await widget.evaluate((key) => localStorage.getItem(key), refreshKey);
    expect(afterReset).not.toBe(signedInToken);
    const refused = await fetch(`${s.apiBase}/v1/widget/sessions/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: signedInToken }),
    });
    expect(refused.status).toBe(401);

    // The next person on this browser starts fresh, even after a reload.
    frame = await openWidget(page);
    await expect(frame.getByTestId('greeting')).toBeVisible();
    await expect(frame.getByText(question)).toHaveCount(0);

    // Signing the same customer in again brings their own conversation back.
    await signIn(page, customerId);
    await expect(frame.getByText(question)).toBeVisible();
  });

  test('W12 · signing out in one tab clears the chat in the other tabs', async ({
    page,
    context,
  }) => {
    const question = 'Please change my delivery address';
    const first = await openWidget(page);
    await signIn(page, `amina-${randomUUID().slice(0, 8)}`);
    await ask(first, question);

    // A second tab on the same website resumes the signed-in chat.
    const other = await context.newPage();
    const second = await openWidget(other);
    await expect(second.getByText(question)).toBeVisible();

    await signOut(page);
    await expect(second.getByText(question)).toHaveCount(0);
    await expect(second.getByTestId('greeting')).toBeVisible();
    await expect(first.getByText(question)).toHaveCount(0);
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
