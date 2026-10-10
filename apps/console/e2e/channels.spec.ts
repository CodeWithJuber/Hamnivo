/**
 * Settings → Channels (ADR 0013) in a real browser against the gateway and the fake Chatwoot: the
 * empty page, an email inbox added in Chatwoot and found with "Check for new channels", the AI
 * turned on, a team chosen and the channel paused after a confirm. A channel no brand has claimed
 * yet, and Chatwoot failing after the setting was saved, are answered by the test (the stack has
 * one Chatwoot account per brand, so it never has the first; the second needs Chatwoot down).
 * A channel that has not worked for 15 minutes (A11) is answered by the test as well: the banner
 * reads the gateway's notices, and the stack cannot wait that long. English and Arabic, with axe
 * audits.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, type Request, test } from '@playwright/test';
import { overflowAt } from './access';
import { audit, seedWorkspace, type Workspace } from './support';

interface Channel {
  id: string;
  brandId: string | null;
  kind: string;
  name: string;
  address: string | null;
  status: string;
  aiAnswers: boolean;
  defaultTeamId: string | null;
  pausedAt: string | null;
}

let workspace: Workspace;
let billingTeamId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
  const workspaces = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/workspaces',
  );
  const team = await workspace.staff.call<{ id: string }>('POST', '/v1/admin/teams', {
    name: 'Billing',
    workspaceId: workspaces.items[0]?.id ?? null,
  });
  billingTeamId = team.id;
});

const chatwoot = (): { url: string; platformToken: string } =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8')).chatwoot;

/** Adds an email inbox to the brand's Chatwoot account, as its owner would in Chatwoot. */
async function addEmailInbox(name: string, email: string) {
  const { url, platformToken } = chatwoot();
  const [connection] = (
    await workspace.staff.call<{ items: Array<{ accountId: number }> }>(
      'GET',
      '/v1/admin/authority/connections',
    )
  ).items;
  if (!connection) throw new Error('the brand has no Chatwoot connection');
  const call = async <T>(path: string, token: string, body: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { api_access_token: token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok, `${path} → ${response.status}`).toBe(true);
    return (await response.json()) as T;
  };
  const admin = await call<{ id: number; access_token: string }>(
    '/platform/api/v1/users',
    platformToken,
    { name: 'Chatwoot owner', email: `owner+${randomBytes(4).toString('hex')}@example.com` },
  );
  await call(`/platform/api/v1/accounts/${connection.accountId}/account_users`, platformToken, {
    user_id: admin.id,
    role: 'administrator',
  });
  await call(`/api/v1/accounts/${connection.accountId}/inboxes`, admin.access_token, {
    name,
    channel: { type: 'email', email },
  });
}

const channels = async () =>
  (
    await workspace.staff.call<{ items: Channel[] }>(
      'GET',
      `/v1/admin/brands/${workspace.brand.id}/channels`,
    )
  ).items;

async function open(page: Page, locale = 'en') {
  await page.goto(`/channels?brand=${workspace.brand.id}&lang=${locale}`);
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const cardOf = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name }) });

const isPut = (request: Request) =>
  request.method() === 'PUT' && request.url().includes('/v1/admin/channels/');

test('Channels · empty at first; a new email inbox is found, gets the AI and a team, and is paused', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Settings lists Channels between Chat widget and Automations.
  await open(page);
  const pages = page.getByRole('navigation', { name: 'Settings pages' }).getByRole('link');
  const names = await pages.allTextContents();
  expect(names.indexOf('Channels')).toBe(names.indexOf('Chat widget') + 1);
  expect(names.indexOf('Automations')).toBe(names.indexOf('Channels') + 1);

  await expect(page.getByRole('heading', { level: 1, name: 'Channels' })).toBeVisible();
  await expect(
    page.getByText('Answer email, WhatsApp and Telegram from the same inbox as your web chat.'),
  ).toBeVisible();
  const web = cardOf(page, 'Web chat');
  await expect(web.getByTestId('channel-status')).toHaveText('Connected');
  await expect(web).toContainText('Your website’s chat widget.');
  await expect(web.getByRole('link', { name: 'Chat widget settings' })).toHaveAttribute(
    'href',
    `/chat-widget?brand=${workspace.brand.id}`,
  );
  const empty = page.getByTestId('channels-empty');
  await expect(empty).toContainText('No email, WhatsApp or Telegram channels yet.');
  await expect(empty).toContainText(
    'Connect your support email, a WhatsApp Business number or a Telegram bot here. Channels added in Chatwoot appear when you check for new channels.',
  );
  const violations = await audit(page, 'channels empty (en)');

  // Nothing new yet.
  await empty.getByRole('button', { name: 'Check for new channels' }).click();
  await expect(page.getByTestId('channel-saved')).toHaveText('No new channels');

  // The owner adds an email inbox in Chatwoot, then checks again.
  await addEmailInbox('Support email', 'help@noor.example');
  await page.getByRole('button', { name: 'Check for new channels' }).click();
  await expect(page.getByTestId('channel-saved')).toHaveText('Found 1 new channel');
  await expect(page.locator('[data-slot="announcer-polite"]')).toHaveText('Found 1 new channel');
  const mail = cardOf(page, 'Support email');
  await expect(mail.getByTestId('channel-kind')).toHaveText('Email');
  await expect(mail.getByTestId('channel-address')).toHaveText('help@noor.example');
  await expect(mail.getByTestId('channel-status')).toHaveText('Connected');
  await expect(mail).toContainText('0 conversations this week');
  await expect(mail).toContainText('No messages yet');
  // With channels listed, the check is a secondary button above them.
  await expect(page.getByTestId('channels-empty')).toHaveCount(0);
  await expect(page.getByTestId('check-channels')).toHaveCount(1);
  const [found] = await channels();
  expect(found).toMatchObject({ kind: 'email', brandId: workspace.brand.id, aiAnswers: false });

  // AI answers here: off until turned on; the switch is named and described.
  const ai = mail.getByRole('switch', { name: 'AI answers here Support email' });
  await expect(ai).not.toBeChecked();
  await expect(ai).toHaveAccessibleDescription(
    'Off: your team answers every conversation. On: the AI answers first and hands over to your team when needed.',
  );
  let sent = page.waitForRequest(isPut);
  await ai.focus();
  await page.keyboard.press('Space');
  expect((await sent).postDataJSON()).toEqual({ aiAnswers: true });
  await expect(ai).toBeChecked();
  await expect(mail.getByTestId('channel-saved')).toHaveText(
    'The AI now answers first on Support email.',
  );
  await expect.poll(async () => (await channels())[0]?.aiAnswers).toBe(true);

  // Team: the brand's teams, and routing when none is chosen.
  const team = mail.getByRole('combobox', { name: 'Team' });
  await expect(team.locator('option')).toHaveText(['No team (use routing)', 'Billing']);
  sent = page.waitForRequest(isPut);
  await team.selectOption({ label: 'Billing' });
  expect((await sent).postDataJSON()).toEqual({ defaultTeamId: billingTeamId });
  await expect(mail.getByTestId('channel-saved')).toHaveText(
    'New conversations on Support email now go to Billing.',
  );
  await expect.poll(async () => (await channels())[0]?.defaultTeamId).toBe(billingTeamId);

  // Pausing asks first; cancelling sends nothing.
  await mail.getByRole('button', { name: 'Pause Support email' }).click();
  const dialog = page.getByTestId('pause-channel-dialog');
  await expect(dialog.getByRole('heading', { name: 'Pause Support email?' })).toBeVisible();
  await expect(dialog).toContainText(
    'New conversations on this channel stay in Chatwoot until you resume. Conversations already here carry on.',
  );
  violations.push(...(await audit(page, 'pause dialog (en)')));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await mail.getByRole('button', { name: 'Pause Support email' }).click();
  sent = page.waitForRequest(isPut);
  await dialog.getByRole('button', { name: 'Pause channel' }).click();
  expect((await sent).postDataJSON()).toEqual({ paused: true });
  await expect(dialog).toBeHidden();
  await expect(mail.getByTestId('channel-status')).toHaveText('Paused');
  await expect(mail.getByRole('button', { name: 'Resume Support email' })).toBeFocused();
  await expect.poll(async () => (await channels())[0]?.pausedAt).not.toBeNull();
  violations.push(...(await audit(page, 'channels listed (en)')));
  expect(violations).toEqual([]);
});

test('Channels · a channel found in the Chatwoot account is claimed for the brand', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  const free: Channel & Record<string, unknown> = {
    id: 'inb_01k6x0000000000000000free',
    brandId: null,
    kind: 'whatsapp',
    name: 'Sales WhatsApp',
    address: '+971 50 000 0000',
    status: 'connected',
    problem: null,
    aiAnswers: false,
    defaultTeamId: null,
    conversationsThisWeek: 0,
    lastEventAt: null,
    pausedAt: null,
    createdAt: new Date().toISOString(),
  };
  // The list as the gateway sends it, with the unclaimed channel added.
  await page.route(`**/v1/admin/brands/${workspace.brand.id}/channels`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Channel[] };
    await route.fulfill({ status: response.status(), json: { items: [...body.items, free] } });
  });
  const claims: unknown[] = [];
  await page.route(`**/v1/admin/channels/${free.id}`, async (route) => {
    claims.push(route.request().postDataJSON());
    free.brandId = workspace.brand.id;
    await route.fulfill({ json: free });
  });
  await open(page);
  const wa = cardOf(page, 'Sales WhatsApp');
  await expect(wa.getByTestId('channel-kind')).toHaveText('WhatsApp');
  await expect(wa).toContainText('Found in your Chatwoot account.');
  await expect(wa.getByRole('switch')).toHaveCount(0);
  await wa.getByRole('button', { name: 'Use for this brand' }).click();
  await expect(wa.getByTestId('channel-saved')).toHaveText(
    `Sales WhatsApp now answers for ${workspace.brand.name}.`,
  );
  expect(claims).toEqual([{ brandId: workspace.brand.id }]);
  await expect(wa.getByRole('switch', { name: 'AI answers here Sales WhatsApp' })).toBeVisible();
  await expect(wa.getByRole('button', { name: 'Pause Sales WhatsApp' })).toBeVisible();
});

test('Channels · when Chatwoot is not updated, the card says what was saved', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  const detail =
    'The setting is saved, but Chatwoot could not take this channel from the AI yet. Please try again.';
  await page.route('**/v1/admin/channels/*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      json: {
        type: 'https://hamnivo.dev/problems/authority-unavailable',
        title: 'Chatwoot is unavailable',
        status: 503,
        code: 'AUTHORITY_UNAVAILABLE',
        detail,
        requestId: 'req_e2e_503',
      },
    }),
  );
  await open(page);
  const mail = cardOf(page, 'Support email');
  const ai = mail.getByRole('switch', { name: 'AI answers here Support email' });
  await expect(ai).toBeChecked();
  await ai.click();
  const alert = mail.getByRole('alert');
  await expect(alert).toContainText('Chatwoot didn’t answer');
  await expect(alert).toContainText(detail);
  await expect(alert).toContainText('req_e2e_503');
  // The page reads the channel again and shows what the gateway has.
  await expect(ai).toBeChecked();
  expect(await audit(page, 'channel problem (en)')).toEqual([]);
});

test('Channels · Arabic, right to left, on a phone too', async ({ page, context }) => {
  await workspace.staff.signIn(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1, name: 'القنوات' })).toBeVisible();
  await expect(page.getByTestId('web-chat-card')).toContainText('الدردشة على الموقع');
  const mail = cardOf(page, 'Support email');
  await expect(mail.getByTestId('channel-kind')).toHaveText('البريد الإلكتروني');
  await expect(mail.getByTestId('channel-status')).toHaveText('متوقفة مؤقتًا');
  // The address keeps its own direction inside the right-to-left page.
  await expect(mail.getByTestId('channel-address').locator('bdi')).toHaveAttribute('dir', 'ltr');
  await expect(mail.getByRole('switch', { name: /الذكاء الاصطناعي يردّ هنا/ })).toBeChecked();
  await expect(mail.getByRole('button', { name: 'استئناف Support email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'البحث عن قنوات جديدة' })).toBeVisible();
  const violations = await audit(page, 'channels (ar)');
  violations.push(...(await overflowAt(page)));
  expect(violations).toEqual([]);
});

test('A11 · a channel down for 15 minutes shows a banner that leads to Channels', async ({
  page,
  context,
}) => {
  await workspace.staff.signIn(context);
  const since = new Date(Date.now() - 20 * 60_000).toISOString();
  const down = (id: string, kind: string, brandId: string, brandName: string) => ({
    id,
    brandId,
    brandName,
    kind,
    name: `${brandName} ${kind}`,
    address: kind === 'telegram' ? null : '+971501234567',
    problem: 'Invalid access token',
    since,
  });
  let unhealthy = [down('inbox_e2e_1', 'whatsapp', workspace.brand.id, workspace.brand.name)];
  // The notices as the gateway sends them, with channels that stopped working added.
  await page.route('**/v1/workspace/notices', async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        status: response.status(),
        json: { ...body, unhealthyChannels: unhealthy },
      });
    } catch {
      // A poll still on its way when the page navigates is dropped with the page ("Response has
      // been disposed"); there is nobody left to answer. The banner checks below still apply.
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/inbox?lang=en');
  const banner = page.getByTestId('channel-down-banner');
  await expect(banner).toContainText(
    new RegExp(
      `The WhatsApp channel of ${workspace.brand.name} has not worked since .+\\. New messages may not reach your team\\.`,
    ),
  );
  await expect(banner).toContainText(`${workspace.brand.name} whatsapp · +971501234567`);
  await expect(banner).toContainText('Chatwoot says: Invalid access token');
  const fix = banner.getByRole('link', { name: 'Fix it' });
  await expect(fix).toHaveAttribute('href', `/channels?brand=${workspace.brand.id}`);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const violations = await audit(page, 'channel down banner (en)');
  await fix.click();
  await expect(page).toHaveURL(new RegExp(`/channels\\?brand=${workspace.brand.id}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Channels' })).toBeVisible();

  // Several: counted and listed, the link going to the first one's brand.
  unhealthy = [
    ...unhealthy,
    down('inbox_e2e_2', 'email', workspace.brand.id, workspace.brand.name),
    down('inbox_e2e_3', 'telegram', workspace.brand.id, workspace.brand.name),
  ];
  await page.goto('/inbox?lang=en');
  await expect(banner).toContainText(
    'Channels that have stopped working: 3. New messages may not reach your team.',
  );
  await expect(banner.getByRole('listitem')).toHaveCount(3);
  await expect(banner.getByRole('listitem').nth(1)).toContainText(
    `The Email channel of ${workspace.brand.name}, since`,
  );
  await expect(banner.getByRole('link', { name: 'Fix it' })).toHaveCount(1);

  // Right to left, on a phone too.
  unhealthy = unhealthy.slice(0, 1);
  await page.goto('/inbox?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(banner).toContainText(`قناة واتساب الخاصة بـ ${workspace.brand.name} لا تعمل منذ`);
  await expect(banner.getByRole('link', { name: 'أصلحها' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  violations.push(...(await audit(page, 'channel down banner (ar)')));
  violations.push(...(await overflowAt(page, [320, 390])));

  // Once it works again, the banner goes.
  unhealthy = [];
  await page.goto('/inbox?lang=en');
  await expect(page.locator('#page-title')).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(violations).toEqual([]);
  // Studio keeps asking for notices; one still on its way when the test ends must not fail the
  // next test ("route.fetch: Test ended").
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
