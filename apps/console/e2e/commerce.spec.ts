import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, fromPublicId } from '@hamnivo/db';
import { type BrowserContext, expect, test } from '@playwright/test';
import { audit, PASSWORD, SHOP, seedWorkspace, stack, totp, uniqueEmail } from './support';

/**
 * Studio commerce (boards HNV-21-02, HNV-21-04 and HNV-21-05; C10, C12, C19): a customer pays
 * through the fake Stripe server, one team member asks for a refund, and only a second one, signed
 * in with two-step verification, can approve it. The refund shows as refunded only after the
 * provider says so. A reported delay is recorded with the shop's estimate and stays distinct from
 * the payment.
 */

const stripe = (): { url: string; apiKey: string } =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8')).stripe;

/** A person signed in through the gateway API (as Studio's origin would be). */
class Person {
  tenantId = '';
  constructor(
    readonly email: string,
    public cookie: string,
  ) {}

  static cookieOf(response: Response) {
    return response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  static async signUp(name: string, email = uniqueEmail('commerce')): Promise<Person> {
    const response = await fetch(`${stack().apiBase}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: stack().studioUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    });
    expect(response.ok, `sign-up ${response.status}`).toBe(true);
    // As if they followed the link in the verification email (accepting an invitation needs it).
    const db = createDb(stack().databaseUrl, { max: 1 });
    try {
      await db.$client.query('UPDATE auth."user" SET email_verified = true WHERE email = $1', [
        email,
      ]);
    } finally {
      await db.$client.end();
    }
    return new Person(email, Person.cookieOf(response));
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${stack().apiBase}${path}`, {
      method,
      headers: {
        origin: stack().studioUrl,
        cookie: this.cookie,
        'content-type': 'application/json',
        ...(this.tenantId ? { 'x-hamnivo-tenant': this.tenantId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Turns on two-step verification and signs in again with a code (MFA session). */
  async withTwoFactor(): Promise<void> {
    const enabled = await this.call<{ totpURI: string }>('POST', '/api/auth/two-factor/enable', {
      password: PASSWORD,
    });
    const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
    await this.call('POST', '/api/auth/two-factor/verify-totp', { code: totp(secret) });
    const first = await fetch(`${stack().apiBase}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: stack().studioUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: PASSWORD }),
    });
    const second = await fetch(`${stack().apiBase}/api/auth/two-factor/verify-totp`, {
      method: 'POST',
      headers: {
        origin: stack().studioUrl,
        'content-type': 'application/json',
        cookie: Person.cookieOf(first),
      },
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(second.ok, `two-step sign-in ${second.status}`).toBe(true);
    this.cookie = Person.cookieOf(second);
  }

  async signIn(context: BrowserContext) {
    const url = stack().studioUrl;
    await context.addCookies(
      this.cookie.split('; ').map((pair) => {
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url };
      }),
    );
    await context.addInitScript((tenantId) => {
      try {
        window.localStorage.setItem('hamnivo.studio.tenant', tenantId);
      } catch {
        // Private mode: Studio then asks which workspace to open.
      }
    }, this.tenantId);
  }
}

/** A customer buys a notebook in chat and pays on the (fake) Stripe page. */
async function paidOrder(widgetId: string): Promise<{ orderId: string; reference: string }> {
  const { apiBase, widgetOrigin } = stack();
  const headers = { origin: widgetOrigin, 'content-type': 'application/json' };
  const session = await fetch(`${apiBase}/v1/widget/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ widgetId, hostOrigin: SHOP, locale: 'en' }),
  });
  const { accessToken } = (await session.json()) as { accessToken: string };
  const authed = { ...headers, authorization: `Bearer ${accessToken}` };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: authed,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    expect(response.ok, `${method} ${path} → ${response.status} ${JSON.stringify(json)}`).toBe(
      true,
    );
    return json;
  };
  const conversation = await call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: 'I would like two notebooks',
  });
  const base = `/v1/widget/conversations/${conversation.id}/commerce`;
  const cart = await call('POST', `${base}/cart`, {
    expectedRevision: null,
    lines: [{ productId: 'prod_notebook', variantId: null, quantity: 2 }],
  });
  const quote = await call('POST', `${base}/cart/quote`, { cartRevision: cart.revision });
  const purchase = await call('POST', `${base}/quotes/${quote.id}/approve`, {
    quoteHash: quote.hash,
    cartRevision: cart.revision,
    clientRequestId: randomUUID(),
  });
  // The customer presses Pay on the provider's page; the provider then sends its webhooks.
  await fetch(purchase.checkout.url, { method: 'POST', redirect: 'manual' });
  await expect
    .poll(async () => (await call('GET', `${base}/purchases/${purchase.id}`)).outcome, {
      timeout: 30_000,
    })
    .toBe('paid');
  return { orderId: purchase.order.id, reference: purchase.order.reference };
}

async function member(owner: Person, name: string, role: string, twoFactor: boolean) {
  const roles = await owner.call<{ items: Array<{ key: string; id: string }> }>(
    'GET',
    '/v1/admin/roles',
  );
  const email = uniqueEmail(role);
  const invitation = await owner.call<{ token: string }>('POST', '/v1/admin/invitations', {
    email,
    roleId: roles.items.find((r) => r.key === role)?.id,
    scope: { type: 'tenant' },
    grantExpiresAt: null,
  });
  const person = await Person.signUp(name, email);
  await person.call('POST', '/v1/invitations/accept', { token: invitation.token });
  person.tenantId = owner.tenantId;
  if (twoFactor) await person.withTwoFactor();
  return person;
}

/** A workspace whose brand sells in chat through the fake Stripe; the owner has two-step sign-in. */
async function stripeShop(name: string) {
  const workspace = await seedWorkspace({ brand: name, connect: true });
  const owner = new Person(workspace.staff.email, workspace.staff.cookie);
  owner.tenantId = workspace.staff.tenantId;
  await owner.withTwoFactor();
  const webhookSecret = `whsec_${randomUUID().replaceAll('-', '')}`;
  const merchant = await owner.call<{ webhookUrl: string }>(
    'POST',
    '/v1/admin/commerce/merchants',
    {
      brandId: workspace.brand.id,
      provider: 'stripe',
      displayName: name,
      currencies: ['AED'],
      apiKey: stripe().apiKey,
      webhookSecret,
      shipping: { amountMinor: '1000', label: 'Delivery' },
      refundPolicy: { approval: 'always', requireSeparateApprover: true },
    },
  );
  await fetch(`${stripe().url}/__fake/webhook-endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: merchant.webhookUrl, secret: webhookSecret }),
  });
  return { workspace, owner };
}

test('HNV-21-04 HNV-21-05 · a refund waits for a second person, then shows refunded only when the provider confirms', async ({
  browser,
}) => {
  const { workspace, owner } = await stripeShop('Noor Books');
  const { orderId, reference } = await paidOrder(workspace.brand.widgetId);
  const supervisor = await member(owner, 'Sami Supervisor', 'supervisor', false);
  const finance = await member(owner, 'Farah Finance', 'finance', true);

  // The requester sees the order, asks for a refund, and cannot approve their own request.
  const requesterContext = await browser.newContext();
  await supervisor.signIn(requesterContext);
  const requester = await requesterContext.newPage();
  await requester.goto('/orders');
  await expect(requester.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await requester.getByRole('link', { name: reference }).click();
  await expect(
    requester.getByRole('heading', { level: 1, name: `Order ${reference}` }),
  ).toBeVisible();
  await expect(requester.getByTestId('order-total')).toContainText('80.00');
  await requester.getByRole('button', { name: 'Request a refund' }).click();
  const sheet = requester.getByTestId('refund-sheet');
  // U06: "1,500" can be read two ways, so Studio asks instead of guessing.
  await sheet.getByLabel('Amount in AED').fill('1,500');
  await sheet.getByRole('button', { name: 'Request refund' }).click();
  const readings = sheet.getByRole('group', { name: 'Which amount do you mean?' });
  await expect(readings.getByRole('radio')).toHaveCount(2);
  await expect(readings).toContainText('1,500.00');
  await expect(readings).toContainText('1.50');
  expect(await audit(requester, 'ambiguous amount')).toEqual([]);
  // Arabic-Indic digits are read exactly.
  await sheet.getByLabel('Amount in AED').fill('٣٥');
  await expect(readings).toBeHidden();
  await sheet.getByLabel('Reason').selectOption('damaged');
  await sheet.getByRole('button', { name: 'Request refund' }).click();
  await expect(sheet).toBeHidden();
  const refund = requester.locator('[data-refund]').first();
  await expect(refund.getByTestId('refund-state')).toHaveText('Waiting for approval');
  await expect(refund).toContainText('AED');
  await expect(refund.getByTestId('approval-note')).toHaveText(
    'You asked for this refund, so someone else must approve it.',
  );
  await expect(refund.getByRole('button', { name: 'Approve refund' })).toBeDisabled();
  expect(await audit(requester, 'order detail (requester)')).toEqual([]);

  // A second person, with two-step verification, approves it.
  const approverContext = await browser.newContext();
  await finance.signIn(approverContext);
  const approver = await approverContext.newPage();
  await approver.goto(`/orders/${orderId}`);
  const pending = approver.locator('[data-refund]').first();
  await expect(pending.getByTestId('refund-state')).toHaveText('Waiting for approval');
  await pending.getByRole('button', { name: 'Approve refund' }).click();
  const dialog = approver.getByTestId('approve-refund-dialog');
  await expect(dialog).toContainText('Approve a refund of AED');
  await dialog.getByRole('button', { name: 'Approve and send' }).click();
  await expect(dialog).toBeHidden();
  await expect(pending.getByTestId('refund-state')).toHaveText('Pending with the provider');
  await expect(pending).toContainText('It is not refunded until the provider confirms it.');
  await expect(approver.getByTestId('refunded-amount')).toContainText('0.00');

  // The provider settles it; Studio shows it as refunded from the provider's event.
  const refunds = (await (await fetch(`${stripe().url}/__fake/refunds`)).json()) as {
    data: Array<{ id: string }>;
  };
  const refundId = refunds.data.at(-1)?.id ?? '';
  await fetch(`${stripe().url}/__fake/refunds/${refundId}/settle?outcome=succeeded`, {
    method: 'POST',
  });
  await expect(pending.getByTestId('refund-state')).toHaveText('Refunded', { timeout: 30_000 });
  await expect(approver.getByTestId('refunded-amount')).toContainText('35.00');
  expect(await audit(approver, 'order detail (approver)')).toEqual([]);

  // Right to left in Arabic, and still accessible.
  await approver.goto(`/orders/${orderId}?lang=ar`);
  await expect(approver.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(approver.getByRole('heading', { level: 1 })).toContainText(reference);
  expect(await audit(approver, 'order detail (ar)')).toEqual([]);

  // Nothing is left for finance to resolve.
  await approver.goto('/finance?lang=en');
  await expect(
    approver.getByRole('heading', { level: 1, name: 'Finance exceptions' }),
  ).toBeVisible();
  await expect(approver.getByText('Nothing needs attention.')).toBeVisible();
  expect(await audit(approver, 'finance exceptions')).toEqual([]);

  await requesterContext.close();
  await approverContext.close();
});

test('E02 · a shop that refunds only whole payments is offered the full amount', async ({
  browser,
}) => {
  const { workspace, owner } = await stripeShop('Noor Gifts');
  const { orderId } = await paidOrder(workspace.brand.widgetId);
  // As if the provider account could not refund part of a payment (its capability manifest).
  const db = createDb(stack().databaseUrl, { max: 1 });
  const connection = await db.$client.connect();
  try {
    await connection.query('begin');
    await connection.query("select set_config('app.tenant_id', $1, true)", [
      fromPublicId('tenant', owner.tenantId),
    ]);
    await connection.query(
      `update merchant_connections
          set capabilities = jsonb_set(capabilities, '{refunds,partial}', 'false')
        where brand_id = $1`,
      [fromPublicId('brand', workspace.brand.id)],
    );
    await connection.query('commit');
  } finally {
    connection.release();
    await db.$client.end();
  }

  const context = await browser.newContext();
  await owner.signIn(context);
  const page = await context.newPage();
  await page.goto(`/orders/${orderId}`);
  await page.getByRole('button', { name: 'Request a refund' }).click();
  const sheet = page.getByTestId('refund-sheet');
  await expect(sheet.getByTestId('refund-full-only')).toHaveText(
    'This shop can only refund the full amount: AED 80.00.',
  );
  await expect(sheet.getByLabel('Amount in AED')).toHaveCount(0);
  expect(await audit(page, 'full refund only')).toEqual([]);
  await sheet.getByLabel('Reason').selectOption('not_delivered');
  await sheet.getByRole('button', { name: 'Request refund' }).click();
  await expect(sheet).toBeHidden();
  const refund = page.locator('[data-refund]').first();
  await expect(refund.getByTestId('refund-state')).toHaveText('Waiting for approval');
  await expect(refund).toContainText('80.00');
  await context.close();
});

test('HNV-21-02 · a delay is recorded with the shop’s estimate; paid and delayed stay distinct', async ({
  browser,
}) => {
  const { workspace, owner } = await stripeShop('Noor Stationery');
  const { orderId, reference } = await paidOrder(workspace.brand.widgetId);
  const context = await browser.newContext();
  await owner.signIn(context);
  const page = await context.newPage();
  await page.goto(`/orders/${orderId}`);
  await expect(page.getByRole('heading', { level: 1, name: `Order ${reference}` })).toBeVisible();
  await expect(page.getByTestId('order-fulfilment-state')).toHaveText('Not started');

  await page.getByRole('button', { name: 'Record an update' }).click();
  const dialog = page.getByTestId('fulfilment-dialog');
  await dialog.getByLabel('New status').selectOption('delayed');
  await dialog.getByLabel('Estimated date').fill('2026-10-05');
  await dialog.getByLabel('Note for the team').fill('Waiting for stock');
  await expect(dialog).toContainText('The customer sees it as an estimate, not a promise.');
  expect(await audit(page, 'record an update')).toEqual([]);
  await dialog.getByRole('button', { name: 'Save and tell the customer' }).click();
  await expect(dialog).toBeHidden();

  const shipment = page.locator('[data-fulfilment]').first();
  await expect(shipment.getByTestId('fulfilment-state')).toHaveText('Delayed');
  await expect(shipment.getByTestId('fulfilment-estimate')).toHaveText(
    'Estimate from the shop: Oct 5, 2026',
  );
  await expect(shipment).toContainText('Recorded by the team');
  await expect(shipment).toContainText('Waiting for stock');
  await expect(page.getByTestId('order-fulfilment-state')).toHaveText('Delayed');
  await expect(page.locator('[data-payment]').first()).toHaveText('Paid');
  expect(await audit(page, 'order detail with a delay')).toEqual([]);

  // Shipped is its own step, and the estimate the shop gave stays until it is delivered.
  await page.getByRole('button', { name: 'Record an update' }).click();
  await dialog.getByLabel('New status').selectOption('shipped');
  await dialog.getByLabel('Tracking reference').fill('TRK-5501');
  await dialog.getByRole('button', { name: 'Save and tell the customer' }).click();
  await expect(dialog).toBeHidden();
  await expect(shipment.getByTestId('fulfilment-state')).toHaveText('Shipped');
  await expect(shipment).toContainText('TRK-5501');
  await expect(shipment.getByTestId('fulfilment-estimate')).toContainText('Oct 5, 2026');

  // The order list shows payment and fulfilment side by side.
  await page.goto('/orders');
  const row = page.locator(`[data-order="${reference}"]`);
  await expect(row).toContainText('Paid');
  await expect(row).toContainText('Shipped');

  // Urdu: right to left, and still accessible.
  await page.goto(`/orders/${orderId}?lang=ur`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('[data-fulfilment]').first()).toHaveAttribute(
    'data-fulfilment',
    'shipped',
  );
  expect(await audit(page, 'order detail (ur)')).toEqual([]);
  await context.close();
});
