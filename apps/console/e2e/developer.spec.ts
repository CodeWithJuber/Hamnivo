/**
 * Developer settings (board 19: API keys, D06 webhooks, X05 allowed hosts) in a real browser:
 * secrets shown once, keys used, rotated and revoked, a refused delivery replayed, real events
 * checked the way a receiver checks them (Standard Webhooks signatures), allowed hosts, and the
 * whole page in Arabic on a 390 px phone with the keyboard only. axe audits along the way.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  audit,
  customerAsks,
  PASSWORD,
  type Staff,
  seedWorkspace,
  stack,
  tabTo,
  totp,
} from './support';

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

const hooksUrl = (): string =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8')).hooksUrl;

/** What the local receiver got on this path, oldest first. */
async function received(path: string): Promise<Received[]> {
  const response = await fetch(`${hooksUrl()}/__received?path=${encodeURIComponent(path)}`);
  return (await response.json()) as Received[];
}

/** Makes the receiver answer this status on the path from now on. */
async function answerWith(path: string, status: number) {
  await fetch(`${hooksUrl()}/__status`, {
    method: 'POST',
    body: JSON.stringify({ path, status }),
  });
}

/** Standard Webhooks, as a receiver checks it: does one of the signatures come from `secret`? */
function signedWith(request: Received, secret: string): boolean {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key)
    .update(
      `${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.body}`,
    )
    .digest('base64');
  return (request.headers['webhook-signature'] ?? '')
    .split(' ')
    .some((signature) => signature === `v1,${expected}`);
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Turns on two-step verification for this person and signs in again with a code. */
async function twoStepCookie(staff: Staff): Promise<string> {
  const enabled = await staff.call<{ totpURI: string }>('POST', '/api/auth/two-factor/enable', {
    password: PASSWORD,
  });
  const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
  await staff.call('POST', '/api/auth/two-factor/verify-totp', { code: totp(secret) });
  const headers = { origin: stack().studioUrl, 'content-type': 'application/json' };
  const first = await fetch(`${stack().apiBase}/api/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: staff.email, password: PASSWORD }),
  });
  const second = await fetch(`${stack().apiBase}/api/auth/two-factor/verify-totp`, {
    method: 'POST',
    headers: { ...headers, cookie: cookieOf(first) },
    body: JSON.stringify({ code: totp(secret) }),
  });
  expect(second.ok, `two-step sign-in ${second.status}`).toBe(true);
  return cookieOf(second);
}

async function signInWith(context: BrowserContext, cookie: string, tenantId: string) {
  const url = stack().studioUrl;
  await context.addCookies(
    cookie.split('; ').map((pair) => {
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url };
    }),
  );
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hamnivo.studio.tenant', id);
    } catch {
      // Private mode: Studio then asks which workspace to open.
    }
  }, tenantId);
}

/** Calls the API with an API key, as an integration would. */
const withKey = (key: string, path: string) =>
  fetch(`${stack().apiBase}${path}`, { headers: { authorization: `Bearer ${key}` } });

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const today = () => new Date().toISOString().slice(0, 10);

test('HNV-19-01 HNV-19-02 · API keys: chosen permissions, shown once, used, rotated with an overlap and revoked', async ({
  page,
  context,
  browser,
}) => {
  const { staff } = await seedWorkspace();
  await staff.signIn(context);
  await page.goto('/developer');
  await expect(page.getByRole('heading', { level: 1, name: 'Developer' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'API keys' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('No API keys yet.')).toBeVisible();

  // Keys are created only by people signed in with two-step verification, and Studio says so.
  await page.getByTestId('create-key').click();
  let create = page.getByTestId('create-key-dialog');
  await create.getByRole('textbox', { name: 'Name' }).fill('Order system');
  await create.getByRole('checkbox', { name: 'Read reports' }).click();
  await create.getByRole('button', { name: 'Create key' }).click();
  await expect(create.getByTestId('action-error')).toContainText(
    'Two-factor authentication needed',
  );
  const violations = await audit(page, 'create key dialog (en)');

  const secured = await browser.newContext();
  await secured.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: stack().studioUrl,
  });
  await signInWith(secured, await twoStepCookie(staff), staff.tenantId);
  const admin = await secured.newPage();
  await admin.goto('/developer?tab=keys');
  await admin.getByTestId('create-key').click();
  create = admin.getByTestId('create-key-dialog');
  await create.getByRole('textbox', { name: 'Name' }).fill('Order system');
  await create.getByRole('checkbox', { name: 'Read reports' }).click();
  await create.getByRole('checkbox', { name: 'Read webhooks' }).click();
  await create.getByRole('combobox', { name: 'Expires in' }).selectOption('30');

  // HNV-19-06: a rate-limited request says when to try again, counting down, with its reference.
  let limited = false;
  await admin.route('**/v1/admin/api-keys', async (route) => {
    if (route.request().method() !== 'POST' || limited) return route.fallback();
    limited = true;
    await route.fulfill({
      status: 429,
      contentType: 'application/problem+json',
      headers: { 'retry-after': '2' },
      body: JSON.stringify({
        type: 'https://hamnivo.dev/problems/rate-limited',
        title: 'Too many requests',
        status: 429,
        code: 'RATE_LIMITED',
        retryable: true,
        requestId: 'req_e2e_rate_limited',
        retryAfter: 2,
      }),
    });
  });
  await create.getByRole('button', { name: 'Create key' }).click();
  const limit = create.getByTestId('action-error');
  await expect(limit).toContainText('Too many requests');
  await expect(limit.getByTestId('retry-countdown')).toHaveText('You can try again in 2 s.');
  await expect(limit.getByTestId('retry-countdown')).toHaveText('You can try again now.');
  await expect(limit).toContainText('req_e2e_rate_limited');
  await admin.unroute('**/v1/admin/api-keys');
  await create.getByRole('button', { name: 'Create key' }).click();

  // Shown once, with a copy button.
  const reveal = admin.getByTestId('key-reveal');
  await expect(reveal).toContainText('API key created');
  await expect(reveal).toContainText('it won’t be shown again');
  const secret = (await reveal.getByTestId('key-reveal-value').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^hv_live_[0-9a-z]{12}_[0-9A-Za-z]{43}$/);
  await reveal.getByTestId('key-reveal-copy').click();
  await expect(reveal.getByTestId('key-reveal-copy-status')).toHaveText('Copied');
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  violations.push(...(await audit(admin, 'key reveal dialog (en)')));
  await reveal.getByTestId('key-reveal-done').click();
  await expect(reveal).toBeHidden();
  expect(await admin.content()).not.toContain(secret);

  const rows = admin.getByTestId('api-key-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Order system');
  await expect(rows.first()).toContainText(`${secret.split('_').slice(0, 3).join('_')}_…`);
  await expect(rows.first()).toContainText('Read reports, Read webhooks');
  await expect(rows.first()).toContainText('Whole workspace');
  await expect(rows.first()).toContainText('Active');
  await expect(rows.first()).toContainText('Never used');

  // The integration uses it: what it was given works, nothing else does.
  expect((await withKey(secret, '/v1/api-keys/current')).status).toBe(200);
  const range = `from=${today()}&to=${today()}&timezone=UTC`;
  expect((await withKey(secret, `/v1/admin/analytics/overview?${range}`)).status).toBe(200);
  expect((await withKey(secret, '/v1/admin/billing')).status).toBe(403);
  expect((await withKey(`${secret}x`, '/v1/api-keys/current')).status).toBe(401);
  await admin.reload();
  await expect(rows.first()).not.toContainText('Never used');

  // Rotation: a new secret, shown once; the old key keeps working for the overlap.
  await admin.getByRole('button', { name: 'Rotate Order system' }).click();
  const rotate = admin.getByTestId('rotate-key-dialog');
  await expect(rotate.getByRole('combobox', { name: 'The old key keeps working for' })).toHaveValue(
    '60',
  );
  await rotate.getByRole('button', { name: 'Rotate key' }).click();
  await expect(reveal).toBeVisible();
  const rotated = (await reveal.getByTestId('key-reveal-value').textContent())?.trim() ?? '';
  expect(rotated).toMatch(/^hv_live_/);
  expect(rotated).not.toBe(secret);
  await reveal.getByTestId('key-reveal-done').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Being replaced' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Active' })).toHaveCount(1);
  expect((await withKey(secret, '/v1/api-keys/current')).status).toBe(200);
  expect((await withKey(rotated, '/v1/api-keys/current')).status).toBe(200);

  // Revoking stops the key at once.
  await rows
    .filter({ hasText: 'Active' })
    .getByRole('button', { name: 'Revoke Order system' })
    .click();
  const revoke = admin.getByTestId('revoke-key-dialog');
  await expect(revoke).toContainText('This cannot be undone.');
  await revoke.getByRole('button', { name: 'Revoke key' }).click();
  await expect(revoke).toBeHidden();
  await expect(rows.filter({ hasText: 'Revoked' })).toHaveCount(1);
  expect((await withKey(rotated, '/v1/api-keys/current')).status).toBe(401);
  violations.push(...(await audit(admin, 'api keys (en)')));
  await secured.close();
  expect(violations).toEqual([]);
});

test('HNV-19-03 HNV-19-04 HNV-19-05 · webhooks: a refused test replayed, signed real events and a rotated secret', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const workspace = await seedWorkspace({ connect: true });
  const path = `/hooks/${randomBytes(4).toString('hex')}`;
  await answerWith(path, 503);
  await workspace.staff.signIn(context);
  await page.goto('/developer?tab=webhooks');
  await expect(page.getByText('No endpoints yet. Add one to receive events.')).toBeVisible();

  await page.getByTestId('add-endpoint').click();
  const form = page.getByTestId('endpoint-form');
  const address = form.getByRole('textbox', { name: 'Endpoint address' });
  // Private and link-local addresses are refused before anything is stored (SSRF).
  await address.fill('https://169.254.169.254/latest/meta-data');
  await form.getByRole('checkbox', { name: 'conversation.created' }).click();
  await form.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await address.fill(`${hooksUrl()}${path}`);
  await form.getByRole('textbox', { name: /^Description/ }).fill('Order system');
  await form.getByRole('checkbox', { name: 'message.created' }).click();
  await expect(form.getByText('A conversation started.')).toBeVisible();
  const violations = await audit(page, 'endpoint form (en)');
  await form.getByRole('button', { name: 'Add endpoint' }).click();

  const reveal = page.getByTestId('endpoint-secret-reveal');
  await expect(reveal).toContainText('Endpoint added');
  const secret =
    (await reveal.getByTestId('endpoint-secret-reveal-value').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
  await reveal.getByTestId('endpoint-secret-reveal-done').click();

  const drawer = page.getByTestId('endpoint-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Not tested yet');
  await expect(drawer.getByTestId('secret-hint')).toHaveText(`whsec_••••${secret.slice(-4)}`);
  expect(await page.content()).not.toContain(secret);

  // The receiver is down: the signed test is refused, and the answer is shown.
  await drawer.getByTestId('send-test').click();
  const result = drawer.getByTestId('test-result');
  await expect(result).toContainText('Error answer');
  await expect(result).toContainText('HTTP 503');
  await expect.poll(async () => (await received(path)).length).toBe(1);
  const [refused] = await received(path);
  if (!refused) throw new Error('no request');
  expect(signedWith(refused, secret)).toBe(true);
  expect(JSON.parse(refused.body)).toMatchObject({ type: 'webhook.test' });

  // Its delivery: every attempt, the answer's excerpt, and a payload preview.
  const history = drawer.getByTestId('delivery-history');
  await expect(history.getByTestId('delivery-row')).toHaveCount(1);
  await expect(history.getByTestId('delivery-row').first()).toContainText('Failed');
  await history.getByTestId('delivery-row').first().click();
  const detail = drawer.getByTestId('delivery-detail');
  await expect(detail.getByTestId('attempt-log')).toContainText('HTTP 503');
  await expect(detail.getByTestId('attempt-log')).toContainText('receiver unavailable');
  await expect(detail.getByTestId('payload-preview')).toContainText('webhook.test');
  violations.push(...(await audit(page, 'delivery detail (en)')));

  // Back up: the replay carries the same webhook-id, signed again.
  await answerWith(path, 204);
  await detail.getByTestId('replay-delivery').click();
  const replay = page.getByTestId('replay-dialog');
  await expect(replay).toContainText('the same webhook-id');
  await replay.getByRole('button', { name: 'Replay delivery' }).click();
  await expect.poll(async () => (await received(path)).length, { timeout: 30_000 }).toBe(2);
  const [, replayed] = await received(path);
  if (!replayed) throw new Error('no replay');
  expect(replayed.headers['webhook-id']).toBe(refused.headers['webhook-id']);
  expect(signedWith(replayed, secret)).toBe(true);
  await expect(
    history.getByTestId('delivery-row').filter({ hasText: 'Replay' }).filter({
      hasText: 'Delivered',
    }),
  ).toHaveCount(1, { timeout: 20_000 });

  await drawer.getByTestId('send-test').click();
  await expect(result).toContainText('Verified');
  await expect(drawer).toContainText('Test answered');

  // A real conversation: its events arrive signed, with nothing private in them.
  const conversation = await customerAsks(workspace.brand.widgetId, 'Is my order on its way?');
  await expect
    .poll(
      async () =>
        (await received(path)).filter((r) => JSON.parse(r.body).type === 'conversation.created')
          .length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const events = (await received(path)).filter(
    (r) => JSON.parse(r.body).type === 'conversation.created',
  );
  const created = events[0] as Received;
  expect(signedWith(created, secret)).toBe(true);
  expect(JSON.parse(created.body).data.conversationId).toBe(conversation.id);
  expect(Number(created.headers['webhook-timestamp'])).toBeGreaterThan(Date.now() / 1000 - 120);

  // Rotation: a new secret, shown once; both sign until the overlap ends.
  await drawer.getByTestId('rotate-secret').click();
  const rotate = page.getByTestId('rotate-secret-dialog');
  await expect(
    rotate.getByRole('combobox', { name: 'Keep signing with the old secret for' }),
  ).toHaveValue('24');
  await rotate.getByRole('button', { name: 'Rotate secret' }).click();
  const fresh = page.getByTestId('secret-reveal');
  await expect(fresh).toContainText('New signing secret');
  const next = (await fresh.getByTestId('secret-reveal-value').textContent())?.trim() ?? '';
  expect(next).toMatch(/^whsec_/);
  expect(next).not.toBe(secret);
  await fresh.getByTestId('secret-reveal-done').click();
  await expect(drawer.getByTestId('secret-hint')).toHaveText(`whsec_••••${next.slice(-4)}`);
  await expect(drawer).toContainText('The previous secret also signs until');
  const before = (await received(path)).length;
  await drawer.getByTestId('send-test').click();
  await expect(result).toContainText('Verified');
  await expect.poll(async () => (await received(path)).length).toBe(before + 1);
  const twice = (await received(path)).at(-1) as Received;
  expect(twice.headers['webhook-signature']?.split(' ')).toHaveLength(2);
  expect(signedWith(twice, secret)).toBe(true);
  expect(signedWith(twice, next)).toBe(true);

  // Turned off, nothing is sent and replays wait; turned on again, it is active.
  await drawer.getByTestId('toggle-endpoint').click();
  await page
    .getByTestId('toggle-endpoint-dialog')
    .getByRole('button', { name: 'Turn off' })
    .click();
  await expect(drawer).toContainText('Turned off');
  await expect(drawer.getByRole('button', { name: 'Replay failed' })).toBeDisabled();
  await drawer.getByTestId('toggle-endpoint').click();
  await page.getByTestId('toggle-endpoint-dialog').getByRole('button', { name: 'Turn on' }).click();
  await expect(drawer.getByRole('button', { name: 'Replay failed' })).toBeEnabled();

  // The event log lists what was sent, by type.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('tab', { name: 'Event log' }).click();
  const log = page.getByTestId('event-log');
  await expect(log).toContainText('conversation.created');
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('conversation.created');
  await expect(log.getByRole('row')).toHaveCount(2);
  violations.push(...(await audit(page, 'event log (en)')));
  expect(violations).toEqual([]);
});

test('X05 · allowed hosts: only listed hosts, and the endpoints a list would refuse', async ({
  page,
  context,
}) => {
  const { staff } = await seedWorkspace();
  await staff.call('POST', '/v1/admin/webhooks/endpoints', {
    url: 'https://hooks.partner.example/hamnivo',
    eventTypes: ['order.created'],
  });
  await staff.signIn(context);
  await page.goto('/developer?tab=hosts');
  await expect(page.getByTestId('egress-mode')).toHaveText('Any public host is allowed.');
  await expect(page.getByText('Private networks, this server and local addresses')).toBeVisible();

  const rows = page.getByTestId('egress-hosts').getByRole('listitem');
  await page.getByRole('button', { name: 'Add host' }).click();
  const host = rows.nth(0).getByRole('textbox', { name: 'Host' });
  await host.fill('http://hooks.example.com');
  await page.getByTestId('save-hosts').click();
  await expect(host).toHaveAttribute('aria-invalid', 'true');
  await host.fill('hooks.example.com');
  await rows.nth(0).getByRole('textbox', { name: /^Note/ }).fill('Order system');
  await page.getByTestId('save-hosts').click();
  await expect(page.getByTestId('egress-mode')).toHaveText('Only the hosts below are allowed.');
  await expect(page.getByTestId('blocked-endpoints')).toContainText(
    'https://hooks.partner.example/hamnivo',
  );
  const violations = await audit(page, 'allowed hosts (en)');

  // The endpoint says why nothing reaches it.
  await page.getByRole('tab', { name: 'Webhooks' }).click();
  await page.getByTestId('open-endpoint').click();
  const drawer = page.getByTestId('endpoint-drawer');
  await expect(drawer).toContainText('not on the list of allowed hosts');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // A wildcard for the partner's subdomains lets it through.
  await page.getByRole('tab', { name: 'Allowed hosts' }).click();
  await page.getByRole('button', { name: 'Add host' }).click();
  await rows.nth(1).getByRole('textbox', { name: 'Host' }).fill('*.partner.example');
  await page.getByTestId('save-hosts').click();
  await expect(page.getByTestId('blocked-endpoints')).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  // Emptying the list allows any public host again.
  await page.getByRole('button', { name: 'Remove hooks.example.com' }).click();
  await page.getByRole('button', { name: 'Remove *.partner.example' }).click();
  await page.getByTestId('save-hosts').click();
  await expect(page.getByTestId('egress-mode')).toHaveText('Any public host is allowed.');
  expect(violations).toEqual([]);
});

test('HNV-24-04 HNV-24-06 · Arabic on a 390 px phone, keyboard only: add an endpoint, test it, close and come back', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const { staff } = await seedWorkspace();
  const path = `/hooks/${randomBytes(4).toString('hex')}`;
  await staff.signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/developer?tab=webhooks&lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'المطوّرون' })).toBeVisible();

  const add = page.getByTestId('add-endpoint');
  await tabTo(page, add);
  await page.keyboard.press('Enter');
  const form = page.getByTestId('endpoint-form');
  const address = form.getByRole('textbox', { name: 'عنوان نقطة الاستقبال' });
  await tabTo(page, address);
  await page.keyboard.type(`${hooksUrl()}${path}`);
  await tabTo(page, form.getByRole('checkbox', { name: 'conversation.created' }));
  await page.keyboard.press('Space');
  const submit = form.getByRole('button', { name: 'إضافة نقطة الاستقبال' });
  await tabTo(page, submit);
  await page.keyboard.press('Enter');

  const reveal = page.getByTestId('endpoint-secret-reveal');
  await expect(reveal).toContainText('لن يُعرض مرة أخرى');
  const violations = await audit(page, 'secret reveal (ar, 390)');
  await tabTo(page, reveal.getByRole('button', { name: 'تم' }));
  await page.keyboard.press('Enter');

  const drawer = page.getByTestId('endpoint-drawer');
  await expect(drawer).toBeVisible();
  await tabTo(page, drawer.getByTestId('send-test'));
  await page.keyboard.press('Enter');
  await expect(drawer.getByTestId('test-result')).toContainText('تم التحقق');
  violations.push(...(await audit(page, 'endpoint drawer (ar, 390)')));
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // From the table: open with the keyboard, close with Esc, and focus comes back.
  const open = page.getByTestId('open-endpoint');
  await tabTo(page, open);
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(open).toBeFocused();

  // Every tab: no sideways scrolling at 320 and 390 px, and no axe violations.
  const overflowing: string[] = [];
  for (const tab of ['keys', 'webhooks', 'events', 'hosts']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/developer?tab=${tab}&lang=ar`);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    violations.push(...(await audit(page, `developer ${tab} (ar, 390)`)));
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const extra = await overflow(page);
      if (extra > 1) overflowing.push(`${tab} at ${width}px: ${extra}px too wide`);
    }
  }
  expect(overflowing).toEqual([]);
  expect(violations).toEqual([]);
});
