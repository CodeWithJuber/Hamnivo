/**
 * Reports (board 23: O04 analytics) and workspace usage (A08, A15, A16) in a real browser:
 * small groups withheld until there are enough conversations, the day chart with its keyboard
 * tooltip and table, the CSV export, usage against a plan the operator assigns with the billing
 * command, a limit reached, an AI budget, and an issued invoice. English and Arabic, axe audits.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDb, fromPublicId } from '@hamnivo/db';
import { expect, type Page, test } from '@playwright/test';
import { audit, customerAsks, SHOP, type Staff, seedWorkspace, stack, tabTo } from './support';

interface Overview {
  totals: {
    conversations: { value: number };
    firstResponseMedianSeconds: { sample: number };
  };
  handoffReasons: Array<{ reason: string }>;
}

interface Meter {
  limit: string;
  used: number;
  max: number | null;
}

const settings = (): { databaseUrl: string; platformDatabaseUrl: string } =>
  JSON.parse(readFileSync(new URL('./.stack.json', import.meta.url), 'utf8'));

const day = (date: Date) => date.toISOString().slice(0, 10);
/** Numbers as the Arabic interface writes them (Arabic-Indic digits). */
const ar = (value: number) => new Intl.NumberFormat('ar').format(value);
const today = () => day(new Date());

async function overview(staff: Staff): Promise<Overview> {
  const from = day(new Date(Date.now() - 6 * 86_400_000));
  return staff.call<Overview>(
    'GET',
    `/v1/admin/analytics/overview?from=${from}&to=${today()}&timezone=UTC`,
  );
}

/** Hamnivo's operator runs the billing command (apps/gateway/src/main.billing.ts). */
function billing(args: string[], input?: string): unknown {
  const { databaseUrl, platformDatabaseUrl } = settings();
  const result = spawnSync(
    process.execPath,
    [new URL('../../gateway/dist/main.billing.js', import.meta.url).pathname, ...args],
    {
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_PLATFORM_URL: platformDatabaseUrl,
        HAMNIVO_KEK_BASE64: randomBytes(32).toString('base64'),
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        HAMNIVO_OPERATOR: 'e2e-operator',
      },
    },
  );
  expect(result.status, `billing ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

/** As if the plan had been assigned two months ago, so last month is billed. */
async function backdatePlan(tenantId: string) {
  const db = createDb(settings().databaseUrl, { max: 1 });
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      fromPublicId('tenant', tenantId),
    ]);
    await client.query(`UPDATE tenant_entitlements SET assigned_at = now() - interval '62 days'`);
    await client.query('COMMIT');
  } finally {
    client.release();
    await db.$client.end();
  }
}

/** A visitor starts a conversation through the widget API and gets the raw answer. */
async function startConversation(widgetId: string): Promise<Response> {
  const { apiBase, widgetOrigin } = stack();
  const headers = { origin: widgetOrigin, 'content-type': 'application/json' };
  const session = await fetch(`${apiBase}/v1/widget/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ widgetId, hostOrigin: SHOP, locale: 'en' }),
  });
  const { accessToken } = (await session.json()) as { accessToken: string };
  return fetch(`${apiBase}/v1/widget/conversations`, {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ clientMessageId: randomUUID(), firstMessage: 'One more question' }),
  });
}

/**
 * How the inbox work queue went, written straight to the database as the gateway would: reply-time
 * clocks that ended (five met, one missed), offers (five accepted, two declined as not their area)
 * and AI drafts (five sent, one rejected), on the workspace's own conversations.
 */
async function seedWorkQueue(tenantId: string, conversationIds: string[]) {
  const db = createDb(settings().databaseUrl, { max: 1 });
  const client = await db.$client.connect();
  const ids = conversationIds.map((id) => fromPublicId('conversation', id));
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      fromPublicId('tenant', tenantId),
    ]);
    const staff = await client.query<{ id: string }>('SELECT id FROM staff_members LIMIT 1');
    const staffId = staff.rows[0]?.id;
    const team = await client.query<{ id: string }>(
      `INSERT INTO teams (id, tenant_id, name) VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, 'Returns') RETURNING id`,
    );
    const teamId = team.rows[0]?.id;
    for (const [n, conversationId] of ids.entries()) {
      await client.query(
        `INSERT INTO sla_outcomes (id, tenant_id, conversation_id, kind, priority, target_minutes,
           started_at, ended_at, outcome, business_minutes)
         VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, $1, 'first_reply',
           'medium', 15, now() - interval '20 minutes', now(), $2, $3)`,
        [conversationId, n === 0 ? 'missed' : 'met', n === 0 ? 20 : 5 + n],
      );
      const declined = n === 0 ? 2 : 0;
      for (let round = 1; round <= declined + 1; round += 1) {
        const state = round <= declined ? 'declined' : n === 5 ? 'expired' : 'accepted';
        await client.query(
          `INSERT INTO conversation_offers (id, tenant_id, conversation_id, team_id, staff_member_id,
             handoff_epoch, round, state, decline_reason, offered_at, expires_at, decided_at,
             timeout_seconds)
           VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, $1, $2, $3, 1, $4, $5,
             $6, now() - interval '5 minutes', now() - interval '3 minutes',
             now() - interval '4 minutes', 120)`,
          [
            conversationId,
            teamId,
            staffId,
            round,
            state,
            state === 'declined' ? 'not_my_area' : null,
          ],
        );
      }
      const run = await client.query<{ id: string }>(
        `INSERT INTO runs (id, tenant_id, conversation_id, trigger_ref, kind, state, outcome, epoch)
         VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, $1, $2, 'draft',
           'succeeded', 'drafted', 1) RETURNING id`,
        [conversationId, `draft:e2e:${n}`],
      );
      const asked = await client.query<{ id: string }>(
        `SELECT id FROM message_ledger WHERE conversation_id = $1 AND sender_kind = 'customer' LIMIT 1`,
        [conversationId],
      );
      const state = n === 0 ? 'rejected' : 'approved';
      const draft = await client.query<{ id: string }>(
        `INSERT INTO ai_drafts (id, tenant_id, conversation_id, run_id, trigger_ledger_id,
           owner_epoch, text, state, decided_by, decided_at)
         VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, $1, $2, $3, 1,
           'Your parcel is on its way.', $4, $5, now()) RETURNING id`,
        [conversationId, run.rows[0]?.id, asked.rows[0]?.id, state, staffId],
      );
      if (state === 'rejected') {
        await client.query(
          `INSERT INTO ai_draft_decisions (id, tenant_id, draft_id, staff_member_id,
             client_request_id, decision, reason, owner_epoch)
           VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, $1, $2,
             gen_random_uuid(), 'rejected', 'inaccurate', 1)`,
          [draft.rows[0]?.id, staffId],
        );
      }
    }
    await client.query('COMMIT');
  } finally {
    client.release();
    await db.$client.end();
  }
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('HNV-23-01 HNV-23-02 O04 · reports withhold small groups, then show the day chart, its table and the export', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const { staff } = workspace;
  const first = await customerAsks(workspace.brand.widgetId, 'Where is my order?');
  await customerAsks(workspace.brand.widgetId, 'Do you ship to Lahore?');
  await expect
    .poll(async () => (await overview(staff)).totals.firstResponseMedianSeconds.sample, {
      timeout: 60_000,
    })
    .toBe(2);

  await staff.signIn(context);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await expect(page.getByTestId('tile-conversations')).toContainText('2');
  // Two answered conversations are too few for a median, and the day's count is withheld.
  const firstResponse = page.getByTestId('tile-first-response');
  await expect(firstResponse).toContainText('Small sample');
  await expect(firstResponse).toContainText('Conversations measured: 2');
  await expect(
    page.getByText('To protect privacy, a number that stands on fewer than 5'),
  ).toBeVisible();
  await page.getByText('Show the numbers as a table').click();
  const table = page.getByTestId('chart-table');
  await expect(table.getByRole('row')).toHaveCount(8);
  await expect(table.getByRole('row').last()).toContainText('Withheld');
  await expect(page.getByText('No orders or refunds in this range.')).toBeVisible();
  const violations = await audit(page, 'reports quality, withheld (en)');

  // Enough conversations: the numbers appear; a reason given once stays withheld.
  for (const question of [
    'What are your opening hours?',
    'Can I change my delivery address?',
    'Do you have gift cards?',
    'I want to talk to a person please',
  ]) {
    await customerAsks(workspace.brand.widgetId, question);
  }
  await expect
    .poll(
      async () => {
        const o = await overview(staff);
        return [
          o.totals.conversations.value,
          o.totals.firstResponseMedianSeconds.sample >= 5,
          o.handoffReasons.length,
        ];
      },
      { timeout: 60_000 },
    )
    .toEqual([6, true, 1]);
  await page.reload();
  await expect(page.getByTestId('tile-conversations')).toContainText('6');
  await expect(firstResponse).not.toContainText('Small sample');
  await expect(page.getByTestId('tile-handoffs')).toContainText('Withheld: fewer than 5');
  const reasons = page.getByTestId('handoff-reasons');
  await expect(reasons).toContainText('The customer asked for a person');
  await expect(reasons).toContainText('Small sample');
  // Chats that went wrong: none missed or left with the contact form; no chat was closed, so
  // there is no reopen rate yet.
  await expect(page.getByRole('heading', { name: 'Chats that went wrong' })).toBeVisible();
  await expect(page.getByTestId('tile-missed')).toContainText('Missed chats');
  await expect(page.getByTestId('tile-offline-messages')).toContainText('Contact form messages0');
  await expect(page.getByTestId('tile-reopened')).toContainText('Small sample');
  await expect(page.getByTestId('tile-reopened')).toContainText('Withheld: fewer than 5');
  await page.getByText('Show the numbers as a table').click();
  await expect(table.getByRole('row').last()).toContainText('6');

  // The chart with the keyboard: focus shows the latest day, Home the first, Esc hides it.
  const plot = page.getByTestId('chart-plot');
  await tabTo(page, plot);
  const tooltip = page.getByTestId('chart-tooltip');
  await expect(tooltip).toContainText('6');
  await expect(tooltip).toContainText('this period');
  await page.keyboard.press('Home');
  await expect(tooltip).toContainText(
    new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(Date.now() - 6 * 86_400_000),
    ),
  );
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();

  // The same numbers as CSV.
  const download = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^hamnivo-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const csv = readFileSync((await file.path()) ?? '', 'utf8');
  expect(csv).toContain('totals,conversations,6,');
  expect(csv).toContain(`daily,${today()},6,`);
  expect(csv).toContain('handoff_reason,customer_request,,,true,');
  violations.push(...(await audit(page, 'reports quality (en)')));

  // Teams and channels, then AI use.
  await page.getByRole('tab', { name: 'Team activity' }).click();
  await expect(page.getByTestId('team-table')).toContainText('No team');
  await expect(page.getByTestId('channel-table')).toContainText('6');
  violations.push(...(await audit(page, 'reports teams (en)')));
  await page.getByRole('tab', { name: 'AI usage' }).click();
  await expect(page.getByTestId('tile-ai-replies')).not.toContainText('—');
  await expect(page).toHaveURL(/tab=ai/);
  violations.push(...(await audit(page, 'reports ai (en)')));

  // Tickets: none yet, then one the team made, withheld as a small group like everything else.
  await page.getByRole('tab', { name: 'Tickets' }).click();
  await expect(page).toHaveURL(/tab=tickets/);
  await expect(page.getByTestId('report-empty')).toContainText('No tickets in this date range');
  await staff.call('POST', `/v1/inbox/conversations/${first.id}/ticket`, { priority: 'high' });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Tickets', selected: true })).toBeVisible();
  for (const tile of ['created', 'open', 'close-time']) {
    await expect(page.getByTestId(`tile-tickets-${tile}`)).toBeVisible();
  }
  await expect(page.getByTestId('tile-tickets-created')).toContainText('Small sample');
  await expect(page.getByTestId('tile-tickets-closed')).toContainText('0');
  const priorities = page.getByTestId('tickets-by-priority');
  await expect(priorities.getByRole('row').nth(1)).toContainText('HighSmall sample');
  const sources = page.getByTestId('tickets-by-source');
  await expect(sources.getByRole('row').nth(1)).toContainText('StaffSmall sample');
  violations.push(...(await audit(page, 'reports tickets (en)')));

  // Right to left: the same report in Arabic.
  await page.goto('/reports?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'التقارير' })).toBeVisible();
  await expect(page.getByTestId('tile-conversations')).toContainText(ar(6));
  violations.push(...(await audit(page, 'reports quality (ar)')));

  // On a phone, every tab (the day table open) fits without sideways scrolling and passes axe.
  const overflowing: string[] = [];
  for (const tab of ['quality', 'teams', 'tickets', 'ai', 'billing']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/reports?tab=${tab}&lang=ar`);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    if (tab === 'quality') await page.getByText('عرض الأرقام في جدول').click();
    violations.push(...(await audit(page, `reports ${tab} (ar, 390)`)));
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const extra = await overflow(page);
      if (extra > 1) overflowing.push(`${tab} at ${width}px: ${extra}px too wide`);
    }
  }
  expect(overflowing).toEqual([]);
  expect(violations).toEqual([]);
});

test('H12 HNV-10-06 HNV-09-05 · reports on reply-time targets, offers and AI drafts', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const { staff } = workspace;
  const conversations: string[] = [];
  for (const question of [
    'Where is my order?',
    'Do you ship to Lahore?',
    'What are your opening hours?',
    'Can I change my delivery address?',
    'Do you have gift cards?',
    'Is the blue scarf in stock?',
  ]) {
    conversations.push((await customerAsks(workspace.brand.widgetId, question)).id);
  }
  await expect
    .poll(async () => (await overview(staff)).totals.conversations.value, { timeout: 60_000 })
    .toBe(6);
  await seedWorkQueue(staff.tenantId, conversations);

  await staff.signIn(context);
  await page.goto('/reports');
  const targets = page.getByTestId('reply-targets-report');
  await expect(page.getByRole('heading', { name: 'Reply-time targets' })).toBeVisible();
  // Five of six replies in time; one miss is too few to show.
  await expect(page.getByTestId('tile-targets-met')).toContainText('83%');
  await expect(page.getByTestId('tile-targets-met')).toContainText('Of 6 replies from a person');
  await expect(page.getByTestId('tile-targets-missed')).toContainText('Small sample');
  await expect(page.getByTestId('reply-targets-by-priority')).toContainText('Medium6');
  await expect(targets).toContainText('Reply-time targets have been recorded since');
  const violations = await audit(page, 'reports reply-time targets (en)');

  await page.getByRole('tab', { name: 'Team activity' }).click();
  await expect(page.getByRole('heading', { name: /Chats offered/ })).toBeVisible();
  // Five accepted, two declined and one ran out: 5 of 8.
  await expect(page.getByTestId('tile-offers-accepted')).toContainText('63%');
  await expect(page.getByTestId('offers-decline-reasons')).toContainText(
    'Not their areaSmall sample',
  );
  await expect(page.getByTestId('offers-by-team')).toContainText('Returns8');
  violations.push(...(await audit(page, 'reports offers (en)')));

  await page.getByRole('tab', { name: 'AI usage' }).click();
  await expect(page.getByRole('heading', { name: 'AI drafts for review' })).toBeVisible();
  await expect(page.getByTestId('tile-drafts-sent')).toContainText('83%');
  await expect(page.getByTestId('drafts-reject-reasons')).toContainText('It was wrongSmall sample');
  violations.push(...(await audit(page, 'reports AI drafts (en)')));

  const download = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const csv = readFileSync((await (await download).path()) ?? '', 'utf8');
  expect(csv).toContain('reply_targets,met,5,0.8333,false,6');
  expect(csv).toContain('offers,accepted,5,0.625,false,8');
  expect(csv).toContain('ai_drafts,sent,5,0.8333,false,6');

  // Arabic on a phone: every new section reads right to left and fits.
  const overflowing: string[] = [];
  for (const [tab, section] of [
    ['quality', 'reply-targets-report'],
    ['teams', 'offers-report'],
    ['ai', 'ai-drafts-report'],
  ] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/reports?tab=${tab}&lang=ar`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId(section)).toBeVisible();
    violations.push(...(await audit(page, `reports ${tab} work queue (ar, 390)`)));
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const extra = await overflow(page);
      if (extra > 1) overflowing.push(`${tab} at ${width}px: ${extra}px too wide`);
    }
  }
  await expect(page.getByTestId('tile-drafts-sent')).toContainText('أُرسلت');
  expect(overflowing).toEqual([]);
  expect(violations).toEqual([]);
});

test('HNV-23-04 HNV-23-05 HNV-23-06 A08 A15 A16 · usage against the plan, a limit reached, an AI budget and an issued invoice (Arabic)', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ connect: true });
  const { staff } = workspace;
  billing(
    ['plan:set', '-'],
    JSON.stringify({
      key: 'e2e-starter',
      name: 'Starter',
      currency: 'USD',
      priceMinor: '4900',
      limits: {
        conversations: 3,
        aiReplies: 100,
        aiTokens: 200000,
        knowledgeStorageBytes: 5000000,
        seats: 5,
        webhookEndpoints: 1,
      },
      metered: [{ limit: 'conversations', includedUnits: 2, unitPriceMinor: '50', perUnits: 1 }],
    }),
  );
  billing(['plan:assign', staff.tenantId, 'e2e-starter']);

  for (const question of ['Where is my order?', 'Do you ship to Lahore?', 'Gift cards?']) {
    await customerAsks(workspace.brand.widgetId, question);
  }
  await expect
    .poll(
      async () => {
        const usage = await staff.call<{ meters: Meter[] }>('GET', '/v1/admin/usage');
        return usage.meters.find((m) => m.limit === 'conversations')?.used;
      },
      { timeout: 30_000 },
    )
    .toBe(3);
  // The fourth conversation is refused, without telling the visitor about the plan.
  const refused = await startConversation(workspace.brand.widgetId);
  expect(refused.status).toBe(402);
  const problem = (await refused.json()) as { code: string };
  expect(problem.code).toBe('PLAN_LIMIT_REACHED');
  expect(JSON.stringify(problem)).not.toMatch(/starter|\b3\b/i);

  await staff.signIn(context);
  await page.goto('/reports?tab=billing&lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const usage = page.getByTestId('billing');
  await expect(usage.getByTestId('plan-name')).toContainText('Starter');
  const conversations = usage.getByTestId('meter-conversations');
  await expect(conversations).toContainText('بلغ الحد');
  const bar = conversations.getByRole('meter');
  await expect(bar).toHaveAttribute('aria-valuetext', `${ar(3)} من ${ar(3)}`);
  await expect(bar).toHaveAttribute('aria-valuenow', '3');
  await expect(usage.getByTestId('meter-webhookEndpoints')).toContainText('ضمن الحد');
  await expect(usage.getByText('لا فواتير بعد.')).toBeVisible();
  const violations = await audit(page, 'billing (ar)');

  // An AI budget above the plan is refused; within it, it is kept.
  const tokens = usage.getByRole('textbox', { name: /ميزانية رموز الذكاء الاصطناعي الشهرية/ });
  await tokens.fill('300000');
  await usage.getByTestId('save-budget').click();
  await expect(tokens).toHaveAttribute('aria-invalid', 'true');
  await tokens.fill('50000');
  const alerts = usage.getByRole('group', { name: 'نبّهني عند' });
  const at80 = alerts.getByRole('checkbox', { name: '80%' });
  if ((await at80.getAttribute('aria-checked')) !== 'true') await at80.click();
  await usage.getByTestId('save-budget').click();
  await expect
    .poll(async () => {
      const current = await staff.call<{ budget: { aiTokens: number | null } }>(
        'GET',
        '/v1/admin/usage',
      );
      return current.budget.aiTokens;
    })
    .toBe(50000);
  await page.reload();
  await expect(tokens).toHaveValue('50000');
  await expect(alerts.getByRole('checkbox', { name: '80%' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Last month's invoice: drafted and issued by the operator, then shown to the workspace.
  await backdatePlan(staff.tenantId);
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
  const drafts = billing(['invoices:generate', period]) as Array<{
    tenant: string;
    number: string;
  }>;
  const draft = drafts.find((d) => d.tenant === staff.tenantId);
  if (!draft) throw new Error('no invoice drafted for the workspace');
  billing(['invoice:issue', draft.number]);
  await page.reload();
  const invoices = usage.getByTestId('invoices');
  await expect(invoices).toContainText(draft.number);
  await expect(invoices).toContainText('صادرة');
  await invoices.getByRole('button', { name: `عرض الفاتورة ${draft.number}` }).click();
  const dialog = page.getByTestId('invoice-dialog');
  await expect(dialog).toContainText('خطة Starter');
  await expect(dialog).toContainText('الضرائب غير مشمولة.');
  violations.push(...(await audit(page, 'invoice dialog (ar)')));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The plan allows one webhook endpoint: Studio says why a second is refused.
  await staff.call('POST', '/v1/admin/webhooks/endpoints', {
    url: 'https://hooks.partner.example/one',
    eventTypes: ['order.created'],
  });
  await page.goto('/developer?tab=webhooks&lang=ar');
  await page.getByTestId('add-endpoint').click();
  const form = page.getByTestId('endpoint-form');
  await form
    .getByRole('textbox', { name: 'عنوان نقطة الاستقبال' })
    .fill('https://hooks.partner.example/two');
  await form.getByRole('checkbox', { name: 'order.created' }).click();
  await form.getByRole('button', { name: 'إضافة نقطة الاستقبال' }).click();
  await expect(form.getByTestId('action-error')).toContainText('تم بلوغ حد الخطة');
  violations.push(...(await audit(page, 'plan limit error (ar)')));

  await page.goto('/reports?tab=billing&lang=ar');
  await expect(page.getByTestId('billing')).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await overflow(page), `billing at ${width}px`).toBeLessThanOrEqual(1);
  }
  violations.push(...(await audit(page, 'billing (ar, 320)')));
  expect(violations).toEqual([]);
});
