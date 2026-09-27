import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';

/**
 * Shopping in the chat (boards HNV-20-01…06, HNV-21-01, HNV-21-02) against the real gateway and worker, the
 * fake Chatwoot and the fake Stripe server with its hosted payment page. The widget renders every
 * card from Hamnivo's records; payment happens only on the provider's page.
 */

interface Stack {
  hostUrl: string;
  apiBase: string;
  widgetOrigin: string;
  consoleOrigin: string;
  tenantId: string;
  cookie: string;
  stripeUrl: string;
}

const stack = (): Stack =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

/** A call from Studio as the shop's owner. */
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
  const json = await response.json();
  expect(response.ok, `${method} ${path} → ${response.status} ${JSON.stringify(json)}`).toBe(true);
  return json;
}

async function openWidget(page: Page): Promise<FrameLocator> {
  await page.goto(stack().hostUrl);
  const launcher = page.locator('[data-hamnivo-launcher]');
  await expect(launcher).toBeVisible();
  await launcher.click();
  return page.frameLocator('iframe[data-hamnivo-frame]');
}

async function startChat(frame: FrameLocator, text: string) {
  const input = frame.getByRole('textbox', { name: 'Write a message…' });
  await input.fill(text);
  await input.press('Enter');
  await expect(frame.locator('[data-sender="customer"]').last()).toContainText(text);
  await expect(frame.getByTestId('shop-bar')).toBeVisible({ timeout: 20_000 });
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

test.describe('Shopping in the chat', () => {
  test('products → cart → exact quote → approval → hosted payment → paid receipt → delay update', async ({
    page,
    context,
  }) => {
    const frame = await openWidget(page);
    await startChat(frame, 'I would like to buy a notebook');

    // HNV-20-01: live products with price, stock and when they were read.
    await frame.getByRole('button', { name: 'Browse products' }).click();
    const catalog = frame.locator('[data-card="catalog"]').last();
    await expect(catalog).toBeVisible({ timeout: 20_000 });
    await expect(catalog).toContainText('Everyday Notebook');
    await expect(catalog).toContainText('The price is checked again before you pay.');

    // HNV-20-02: a draft cart that changes nothing by itself.
    await catalog.getByRole('button', { name: 'Add Everyday Notebook to the cart' }).click();
    await expect(frame.getByTestId('cart-summary')).toContainText('1 item in your cart');
    await catalog.getByRole('button', { name: 'One more Everyday Notebook' }).click();
    await expect(frame.getByTestId('cart-summary')).toContainText('2 items in your cart');

    // HNV-20-03: the exact quote, with seller, delivery, total, expiry and where payment happens.
    await frame.getByRole('button', { name: 'Review order' }).click();
    const quote = frame.locator('[data-card="quote"]').last();
    await expect(quote).toBeVisible({ timeout: 20_000 });
    await expect(quote.getByTestId('quote-total')).toContainText('80.00');
    await expect(quote).toContainText('Seller: Noor Books');
    await expect(quote).toContainText('Nothing is charged in this chat.');
    await expect(quote).toContainText('Refunds: Refunds within 14 days of delivery.');
    const approve = quote.getByRole('button', { name: 'Approve and continue to payment' });
    await expect(approve).toBeEnabled();
    await audit(page);
    await approve.click();

    // HNV-20-04: a trusted hand-over to the provider's page; no card details in the chat.
    const pay = quote.getByRole('link', { name: 'Pay on the secure page' });
    await expect(pay).toBeVisible({ timeout: 20_000 });
    await expect(quote.getByTestId('quote-status')).toContainText('Order HV-');
    await expect(frame.locator('input[autocomplete*="cc-"], input[name*="card"]')).toHaveCount(0);
    const [provider] = await Promise.all([context.waitForEvent('page'), pay.click()]);
    await expect(provider.getByTestId('fake-total')).toContainText('AED 80.00');
    await provider.getByRole('button', { name: /^Pay AED 80\.00$/ }).click();

    // HNV-20-05: coming back proves nothing; the chat shows paid only from the provider's event.
    await provider.waitForURL(/checkout-return\.html\?purchase=pur_/);
    await expect(provider.getByRole('heading', { name: 'Payment step finished' })).toBeVisible();
    await provider.close();
    await page.bringToFront();

    // HNV-21-01: paid and confirmed, with a receipt card in the conversation.
    await expect(quote.getByTestId('quote-status')).toContainText('Paid', { timeout: 30_000 });
    const receipt = frame.locator('[data-card="receipt"]').last();
    await expect(receipt).toContainText('Payment received. Order HV-', { timeout: 30_000 });
    await expect(receipt).toHaveAttribute('data-outcome', 'completed');
    await audit(page);

    // HNV-21-02: the shop reports a delay. The chat shows the milestone, the shop's estimate as
    // an estimate, when it was updated, and a way to reach a person.
    const reference = /HV-[0-9A-Z]{6}/.exec((await receipt.textContent()) ?? '')?.[0] ?? '';
    const found = await staff('GET', `/v1/admin/commerce/orders?q=${reference}`);
    expect(found.items).toHaveLength(1);
    await staff('POST', `/v1/admin/commerce/orders/${found.items[0].id}/fulfillments`, {
      kind: 'shipment',
      state: 'delayed',
      estimateAt: '2026-10-05T00:00:00.000Z',
      note: 'Waiting for stock',
    });
    const status = frame.locator('[data-card="order_status"]').last();
    await expect(status).toHaveAttribute('data-status', 'delayed', { timeout: 30_000 });
    await expect(status.getByTestId('order-milestone')).toHaveText('Delayed');
    await expect(status.getByTestId('order-estimate')).toHaveText(
      "The shop's estimate: Oct 5, 2026. This date is not guaranteed.",
    );
    await expect(status).toContainText('Updated');
    await expect(status).toContainText(`Order ${reference}`);
    await audit(page);
    await status.getByRole('button', { name: 'Talk to a person' }).click();
    await expect(frame.getByTestId('status-banner')).toBeVisible({ timeout: 15_000 });
    await expect(status.getByRole('button', { name: 'Talk to a person' })).toHaveCount(0);
  });

  test('cancelling the payment page keeps the cart; the quote card is right to left in Arabic', async ({
    page,
  }) => {
    const frame = await openWidget(page);
    await startChat(frame, 'Do you have pens?');
    await frame.getByRole('button', { name: 'Browse products' }).click();
    const catalog = frame.locator('[data-card="catalog"]').last();
    await catalog.getByRole('button', { name: 'Add Black Pen Set to the cart' }).click();
    await expect(frame.getByTestId('cart-summary')).toContainText('1 item in your cart');
    await frame.getByRole('button', { name: 'Review order' }).click();
    const quote = frame.locator('[data-card="quote"]').last();
    await quote.getByRole('button', { name: 'Approve and continue to payment' }).click();
    await expect(quote.getByRole('link', { name: 'Pay on the secure page' })).toBeVisible({
      timeout: 20_000,
    });

    // HNV-20-06: cancel safely; nothing charged, the cart is kept for a new quote.
    await quote.getByRole('button', { name: 'Cancel payment' }).click();
    await expect(quote.getByTestId('quote-status')).toContainText('Nothing was charged');
    await expect(frame.getByTestId('cart-summary')).toContainText('1 item in your cart');
    await expect(quote.getByRole('button', { name: 'Review cart again' })).toBeVisible();

    // Arabic: right to left, Arabic wording, and still accessible.
    await frame.getByRole('combobox', { name: 'Language' }).selectOption('ar');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(quote).toContainText('طلبك من Noor Books');
    await expect(quote).toContainText('الإجمالي');
    await audit(page);
  });

  test('C06 · after a bank challenge the same payment page finishes the order, once', async ({
    page,
    context,
  }) => {
    const frame = await openWidget(page);
    await startChat(frame, 'I need pens');
    await frame.getByRole('button', { name: 'Browse products' }).click();
    const catalog = frame.locator('[data-card="catalog"]').last();
    await catalog.getByRole('button', { name: 'Add Black Pen Set to the cart' }).click();
    await expect(frame.getByTestId('cart-summary')).toContainText('1 item in your cart');
    await frame.getByRole('button', { name: 'Review order' }).click();
    const quote = frame.locator('[data-card="quote"]').last();
    await quote.getByRole('button', { name: 'Approve and continue to payment' }).click();
    const pay = quote.getByRole('link', { name: 'Pay on the secure page' });
    await expect(pay).toBeVisible({ timeout: 20_000 });
    const href = (await pay.getAttribute('href')) ?? '';
    const sessionId = href.split('/pay/')[1] ?? '';

    // On the payment page the bank asks for a confirmation; the customer comes back to the chat.
    const challenge = await fetch(`${stack().stripeUrl}/__fake/sessions/${sessionId}/challenge`, {
      method: 'POST',
    });
    const challenged = (await challenge.json()) as {
      data: { object: { id: string; metadata: { hv_reference: string } } };
    };
    await expect(quote.getByTestId('quote-status')).toContainText(
      'Your bank asked you to confirm this payment. Open the secure page again to finish it.',
      { timeout: 30_000 },
    );
    await expect(pay).toHaveAttribute('href', href);
    await audit(page);

    // The same page finishes the payment.
    const [provider] = await Promise.all([context.waitForEvent('page'), pay.click()]);
    await provider.getByRole('button', { name: /^Pay AED/ }).click();
    await provider.waitForURL(/checkout-return\.html\?purchase=pur_/);
    await provider.close();
    await page.bringToFront();
    await expect(quote.getByTestId('quote-status')).toContainText('Paid', { timeout: 30_000 });
    const intents = (await (await fetch(`${stack().stripeUrl}/__fake/payment-intents`)).json()) as {
      data: { id: string; status: string; metadata: { hv_reference?: string } }[];
    };
    const mine = intents.data.filter(
      (i) => i.metadata.hv_reference === challenged.data.object.metadata.hv_reference,
    );
    expect(mine.map((i) => [i.id, i.status])).toEqual([[challenged.data.object.id, 'succeeded']]);
  });

  test('the approval button is disabled once the quote expires', async ({ page }) => {
    await page.clock.install();
    const frame = await openWidget(page);
    await startChat(frame, 'I want a planner or a notebook');
    await frame.getByRole('button', { name: 'Browse products' }).click();
    const catalog = frame.locator('[data-card="catalog"]').last();
    await catalog.getByRole('button', { name: 'Add Everyday Notebook to the cart' }).click();
    await expect(frame.getByTestId('cart-summary')).toContainText('1 item in your cart');
    await frame.getByRole('button', { name: 'Review order' }).click();
    const quote = frame.locator('[data-card="quote"]').last();
    const approve = quote.getByRole('button', { name: 'Approve and continue to payment' });
    await expect(approve).toBeEnabled({ timeout: 20_000 });
    await expect(quote.getByTestId('quote-status')).toContainText('This price is valid until');
    // The quote is valid for five minutes.
    await page.clock.fastForward('06:00');
    await expect(approve).toBeDisabled();
    await expect(quote.getByTestId('quote-status')).toContainText('This price has expired.');
  });
});
