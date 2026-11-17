import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * Nothing shows twice (the owner saw "the previous message repeat"): the customer's own messages,
 * the assistant's replies, a draft that became a reply, and the questions offered next, while
 * replies stream (as in production) and after a reload.
 */
interface Stack {
  hostUrl: string;
  apiBase: string;
  widgetOrigin: string;
  widgetId: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

async function openChat(page: Page) {
  const s = stack();
  const query = new URLSearchParams({
    widgetId: s.widgetId,
    host: s.hostUrl,
    api: s.apiBase,
    locale: 'en',
    instance: `repeat-${Date.now()}`,
  });
  await page.goto(`${s.widgetOrigin}/?${query}`);
  await expect(page.getByTestId('greeting')).toBeVisible();
  return page.getByRole('textbox');
}

/** Each text shown once: what the customer wrote, and what the assistant answered. */
async function shownOnce(page: Page, questions: string[], replies: number) {
  const customer = page.locator('[data-sender="customer"]');
  await expect(customer).toHaveCount(questions.length);
  for (const question of questions) {
    await expect(customer.filter({ hasText: question })).toHaveCount(1);
  }
  await expect(page.locator('[data-sender="ai_primary"]')).toHaveCount(replies, {
    timeout: 20_000,
  });
  // A draft that became the reply is gone, not shown beside it.
  await expect(page.getByTestId('draft-reply')).toHaveCount(0, { timeout: 10_000 });
}

test('two questions in a row: each shown once, each answered once, the same after a reload', async ({
  page,
}) => {
  const input = await openChat(page);
  const first = 'Where is my order 1042?';
  const second = 'Do you deliver on Sundays?';
  await input.fill(first);
  await input.press('Enter');
  // The second follows at once, while the first answer may still be on its way.
  await input.fill(second);
  await input.press('Enter');
  await expect(page.locator('[data-sender="ai_primary"]').first()).toBeVisible({
    timeout: 20_000,
  });
  // One answer to the burst, or one to each: never more than one per question.
  await expect
    .poll(async () => page.locator('[data-sender="ai_primary"]').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  const answered = await page.locator('[data-sender="ai_primary"]').count();
  expect(answered).toBeLessThanOrEqual(2);
  await shownOnce(page, [first, second], answered);

  // The questions offered next never repeat what the customer asked.
  const chips = page.getByTestId('follow-ups').getByRole('button');
  for (const chip of await chips.all()) {
    const text = (await chip.textContent())?.trim() ?? '';
    expect([first, second]).not.toContain(text);
  }

  await page.reload();
  await shownOnce(page, [first, second], answered);
});

test('a reload while the answer is being written shows the question once and one answer', async ({
  page,
}) => {
  const input = await openChat(page);
  const question = 'Can I change my delivery address?';
  await input.fill(question);
  await input.press('Enter');
  await expect(page.locator('[data-sender="customer"]').filter({ hasText: question })).toHaveCount(
    1,
  );
  // Away mid-answer: the page comes back and reads the conversation again.
  await page.reload();
  await shownOnce(page, [question], 1);
});
