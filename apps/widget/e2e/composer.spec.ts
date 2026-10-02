import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

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
  return response.json() as Promise<T>;
}

/** The chat page itself, as the loader opens it, in the given interface language. */
async function openChat(page: Page, locale: 'en' | 'ar' | 'hi' | 'ur') {
  const s = stack();
  const query = new URLSearchParams({
    widgetId: s.widgetId,
    host: s.hostUrl,
    api: s.apiBase,
    locale,
    instance: `composer-${Date.now()}`,
  });
  await page.goto(`${s.widgetOrigin}/?${query}`);
  await expect(page.getByTestId('greeting')).toBeVisible();
  return page.getByRole('textbox');
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

test.beforeAll(async () => {
  // The assistant answers in the four launch languages, so replies follow the customer's choice.
  const agents = await staff<{ items: Array<{ id: string }> }>('GET', '/v1/admin/agents');
  const agentId = agents.items[0]?.id;
  type Config = { languages: string[] } & Record<string, unknown>;
  const detail = await staff<{ published: { config: Config } | null; draft: { config: Config } }>(
    'GET',
    `/v1/admin/agents/${agentId}`,
  );
  const config = detail.published?.config ?? detail.draft.config;
  if (config.languages.length < 4) {
    await staff('PUT', `/v1/admin/agents/${agentId}/draft`, {
      config: { ...config, languages: ['en', 'ar', 'hi', 'ur'] },
    });
    await staff('POST', `/v1/admin/agents/${agentId}/publish`, {});
  }
});

test.describe('U08 · the message box works with input methods and in both directions', () => {
  test('an Enter that confirms an input method composition never sends', async ({ page }) => {
    const input = await openChat(page, 'hi');
    await input.fill('नमस्ते');
    // The browser marks an Enter pressed while composing; Safari sends key code 229 afterwards.
    await input.evaluate((element) => {
      const enter = (init: KeyboardEventInit, keyCode?: number) => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          ...init,
        });
        if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
        element.dispatchEvent(event);
      };
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      enter({ isComposing: true }, 229);
      enter({});
      element.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: 'नमस्ते' }),
      );
      enter({}, 229);
    });
    await expect(page.locator('[data-sender="customer"]')).toHaveCount(0);
    await expect(input).toHaveValue('नमस्ते');

    // Shift+Enter starts a new line; a plain Enter sends.
    await input.press('Shift+Enter');
    await input.pressSequentially('मेरा ऑर्डर');
    await expect(input).toHaveValue('नमस्ते\nमेरा ऑर्डर');
    await input.press('Enter');
    await expect(page.locator('[data-sender="customer"]')).toHaveCount(1);
    await expect(page.locator('[data-sender="customer"]').last()).toContainText('मेरा ऑर्डर');
    await expect(input).toHaveValue('');
  });

  test('each message reads in its own direction, identifiers stay left to right, in RTL', async ({
    page,
  }) => {
    const input = await openChat(page, 'ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // The box follows what is typed.
    await input.fill('Where is my order?');
    await expect(input).toHaveAttribute('dir', 'ltr');
    await input.fill('Order 1048 کہاں ہے؟');
    await expect(input).toHaveAttribute('dir', 'rtl');
    await input.fill('');
    await expect(input).toHaveAttribute('dir', 'auto');

    await input.fill('میرا آرڈر NL-1048 کہاں ہے؟');
    await input.press('Enter');
    const urdu = page.locator('[data-sender="customer"]').last().getByTestId('message-text');
    await expect(urdu).toHaveAttribute('dir', 'rtl');
    await expect(urdu.locator('bdi[dir="ltr"]')).toHaveText('NL-1048');
    // Copying gives back exactly what was sent.
    await expect(urdu).toHaveText('میرا آرڈر NL-1048 کہاں ہے؟');

    const reply = page.locator('[data-sender="ai_primary"]').last().getByTestId('message-text');
    await expect(reply).toContainText('آپ کے پیغام کا شکریہ', { timeout: 20_000 });
    await expect(reply).toHaveAttribute('dir', 'rtl');

    await input.fill('Thanks, and the refund for order NL-1048?');
    await input.press('Enter');
    const english = page.locator('[data-sender="customer"]').last().getByTestId('message-text');
    await expect(english).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('[data-sender="ai_primary"]')).toHaveCount(2, { timeout: 20_000 });

    expect(await audit(page)).toEqual([]);
  });
});

test.describe('HNV-07-04 · the language question', () => {
  test('asks once which language to use for Hinglish or Roman Urdu, and keeps the answer', async ({
    page,
  }) => {
    const input = await openChat(page, 'ur');
    const words = 'Order pay ho gaya, delivery nahi mili';
    await input.fill(words);
    await input.press('Enter');
    // Not English: the Urdu interface suggests Roman Urdu.
    const replies = page.locator('[data-sender="ai_primary"]');
    await expect(replies.last()).toContainText('Aap ke paighaam ka shukriya', { timeout: 20_000 });

    const question = page.getByTestId('language-question');
    await expect(question).toBeVisible();
    const choices = question.getByRole('button');
    await expect(choices).toHaveText(['Roman Urdu', 'Hinglish', 'ابھی نہیں']);
    await expect(question.getByRole('button', { name: 'Hinglish' })).toHaveAttribute(
      'lang',
      'hi-Latn',
    );
    expect(await audit(page)).toEqual([]);

    await question.getByRole('button', { name: 'Hinglish' }).click();
    await expect(question).toHaveCount(0);
    await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText(
      'جوابات اس زبان میں آئیں گے: Hinglish۔',
    );
    // The customer's message stays as they wrote it.
    await expect(page.locator('[data-sender="customer"]').first()).toContainText(words);

    await input.fill(words);
    await input.press('Enter');
    await expect(replies).toHaveCount(2, { timeout: 20_000 });
    await expect(replies.last()).toContainText('Aapke message ke liye dhanyavaad');
    await expect(page.getByTestId('language-question')).toHaveCount(0);

    // A reload does not ask again: the answer is kept on the server.
    await page.reload();
    await expect(replies).toHaveCount(2);
    await expect(page.getByTestId('language-question')).toHaveCount(0);
  });
});
