import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';

/**
 * Approval and result cards for AI actions (W16, G13, G14; boards HNV-13-02/03/05) against the
 * real gateway and worker. The assistant (the deterministic mock model) asks to change a delivery
 * address with the demo order tool; the customer approves exactly what the card shows, by
 * keyboard, in English and in Arabic at phone width, and sees the result only from a receipt.
 */

interface Stack {
  hostUrl: string;
  apiBase: string;
  consoleOrigin: string;
  tenantId: string;
  cookie: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function must(method: string, path: string, body?: unknown) {
  const reply = await staff(method, path, body);
  expect(
    reply.status < 300,
    `${method} ${path} → ${reply.status} ${JSON.stringify(reply.body)}`,
  ).toBe(true);
  return reply.body;
}

let toolId = '';
let agentId = '';

/** Publishes the brand's assistant with these tool grants. */
async function grant(tools: string[]) {
  const detail = await must('GET', `/v1/admin/agents/${agentId}`);
  const config = detail.draft?.config ?? detail.published.config;
  await must('PUT', `/v1/admin/agents/${agentId}/draft`, {
    config: {
      ...config,
      tools: { ...config.tools, grants: tools.map((id) => ({ toolId: id, autopilot: false })) },
    },
  });
  await must('POST', `/v1/admin/agents/${agentId}/publish`, {});
}

async function setStepUp(customerStepUp: boolean) {
  const tool = await must('GET', `/v1/admin/tools/${toolId}`);
  await must('PATCH', `/v1/admin/tools/${toolId}`, {
    expectedRevision: tool.revision,
    customerStepUp,
  });
}

async function openWidget(page: Page): Promise<FrameLocator> {
  await page.goto(stack().hostUrl);
  const launcher = page.locator('[data-hamnivo-launcher]');
  await expect(launcher).toBeVisible();
  await launcher.click();
  return page.frameLocator('iframe[data-hamnivo-frame]');
}

async function ask(frame: FrameLocator, text: string) {
  const input = frame.getByRole('textbox', { name: 'Write a message…' });
  await input.fill(text);
  await input.press('Enter');
  await expect(frame.locator('[data-sender="customer"]').last()).toContainText(text);
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

test.describe('AI action approvals in the chat (W16)', () => {
  test.beforeAll(async () => {
    const agents = await must('GET', '/v1/admin/agents');
    agentId = agents.items[0].id;
    const brands = await must('GET', '/v1/admin/brands');
    const created = await staff('POST', '/v1/admin/tools', {
      brandId: brands.items[0].id,
      builtin: 'demo_update_address',
    });
    if (created.status === 201) toolId = created.body.id;
    else {
      const tools = await must('GET', '/v1/admin/tools');
      toolId = tools.items.find((t: { builtin: string }) => t.builtin === 'demo_update_address').id;
    }
    await grant([toolId]);
  });

  test.afterAll(async () => {
    // The other journeys run without tools.
    await grant([]);
  });

  test('the customer approves exactly what the card shows, by keyboard, and sees the result', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await ask(frame, 'Please change the delivery address of order NL-1048 to 12 Harbour Street');
    const card = frame.locator('[data-card="approval"]').last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-state', 'awaiting_approval');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Change delivery address');
    await expect(card).toContainText(
      'Change the delivery address of order NL-1048 to 12 Harbour Street',
    );
    await expect(card).toContainText('Requested by');
    await expect(card.getByRole('definition')).toContainText('12 Harbour Street');
    const status = card.getByTestId('approval-status');
    await expect(status).toHaveText('Nothing changes until you approve.');
    await audit(page);

    const approve = card.getByRole('button', { name: 'Approve' });
    await approve.focus();
    await page.keyboard.press('Enter');
    // The buttons go away; focus moves to the status line, which reads the outcome.
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(status).toBeFocused();
    const receipt = frame.locator('[data-card="action-receipt"]').last();
    await expect(receipt).toContainText('Result: Done', { timeout: 30_000 });
    await expect(receipt).toContainText(
      'The delivery address of order NL-1048 is now 12 Harbour Street.',
    );
    await expect(status).toHaveText('Done. See the result below.', { timeout: 15_000 });
    await audit(page);
  });

  test('reads right to left in Arabic at phone width; a decline changes nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const frame = await openWidget(page);
    await ask(frame, 'Please change the delivery address of order NL-2048 to 4 Palm Road');
    const card = frame.locator('[data-card="approval"]').last();
    await expect(card).toHaveAttribute('data-state', 'awaiting_approval', { timeout: 30_000 });
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(card).toContainText('مطلوب موافقتك');
    await expect(card.getByTestId('approval-status')).toHaveText('لن يتغيّر شيء قبل موافقتك.');
    // Nothing spills sideways at 390 px.
    const overflow = await frame
      .locator('body')
      .evaluate((body) => body.scrollWidth - body.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await audit(page);

    await card.getByRole('button', { name: 'رفض' }).click();
    await expect(card.getByTestId('approval-status')).toHaveText('تم الرفض. لم يتغيّر شيء.', {
      timeout: 15_000,
    });
    await expect(card).toHaveAttribute('data-state', 'declined');
    await frame.getByRole('combobox', { name: 'اللغة' }).selectOption('en');
  });

  test('a request that asks who the customer is tells the website to sign them in', async ({
    page,
  }) => {
    await setStepUp(true);
    try {
      const frame = await openWidget(page);
      await page.evaluate(() => {
        const host = window as unknown as {
          Hamnivo: { on(event: string, listener: (payload: unknown) => void): void };
          identityRequests: unknown[];
        };
        host.identityRequests = [];
        host.Hamnivo.on('identity.required', (payload) => host.identityRequests.push(payload));
      });
      await ask(frame, 'Please change the delivery address of order NL-3048 to 9 Cedar Lane');
      const card = frame.locator('[data-card="approval"]').last();
      await expect(card).toHaveAttribute('data-state', 'awaiting_approval', { timeout: 30_000 });
      await expect(card).toContainText('You will be asked to confirm who you are.');
      await card.getByRole('button', { name: 'Approve' }).click();
      await expect(card.getByTestId('approval-status')).toHaveText(
        'Please sign in on the website to confirm it is you, then approve again.',
      );
      const requests = await page.evaluate(
        () =>
          (window as unknown as { identityRequests: Array<{ actionId: string }> }).identityRequests,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.actionId).toMatch(/^act_/);
      await expect(card).toHaveAttribute('data-state', 'awaiting_approval');
    } finally {
      await setStepUp(false);
    }
  });
});
