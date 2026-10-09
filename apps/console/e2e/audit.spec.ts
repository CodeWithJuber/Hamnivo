/**
 * Accessibility and layout checks over every main Studio screen, in English and Arabic (right to
 * left): axe (WCAG 2.2 A and AA), no sideways scrolling from 320 to 1920 px, and screenshots for
 * visual review in e2e/screenshots/ (not committed).
 */
import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import {
  audit,
  customerAsks,
  seedKnowledge,
  seedWorkspace,
  type Workspace,
  waitForRun,
} from './support';

const MARKDOWN = `# Shipping

Orders ship within two business days. Delivery to Karachi takes three to five days.

## Returns

You can return a book within 14 days of delivery.
`;
const LOCALES = ['en', 'ar'] as const;
type Locale = (typeof LOCALES)[number];

let workspace: Workspace;
let knowledge: { sourceId: string; documentId: string };
let runId: string;
let automationId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  workspace = await seedWorkspace({ connect: true, publish: true });
  knowledge = await seedKnowledge(workspace, MARKDOWN);
  await workspace.staff.call('POST', '/v1/admin/model-connections', {
    provider: 'openai',
    label: 'OpenAI production',
    apiKey: `sk-audit-${'0'.repeat(20)}wxyz`,
    allowedModels: ['gpt-5-mini'],
  });
  await customerAsks(workspace.brand.widgetId, 'Assalamu alaikum, where is my order?');
  await customerAsks(workspace.brand.widgetId, 'How long does delivery to Karachi take?');
  await waitForRun(workspace.staff);
  const runs = await workspace.staff.call<{ items: Array<{ id: string }> }>(
    'GET',
    '/v1/admin/runs?limit=1',
  );
  runId = runs.items[0]?.id ?? '';
  const automation = await workspace.staff.call<{ id: string }>(
    'POST',
    `/v1/admin/brands/${workspace.brand.id}/automations`,
    {
      name: 'Welcome reply',
      publish: true,
      definition: {
        event: { type: 'chat_started', seconds: 0 },
        match: 'all',
        conditions: [{ field: 'owner', op: 'is', value: ['waiting'] }],
        actions: [{ type: 'send_message', message: { en: 'Someone will reply shortly.' } }],
      },
    },
  );
  automationId = automation.id;
});

const withLang = (path: string, locale: Locale) =>
  `${path}${path.includes('?') ? '&' : '?'}lang=${locale}`;

/** Main screens of a signed-in member, by name. */
const screens = (): Record<string, string> => ({
  tenants: '/tenants',
  overview: '/overview',
  brands: '/brands',
  'chat-widget': `/chat-widget?brand=${workspace.brand.id}`,
  'chat-widget-forms': `/chat-widget?brand=${workspace.brand.id}&tab=forms`,
  'chat-widget-privacy': `/chat-widget?brand=${workspace.brand.id}&tab=privacy`,
  'chat-widget-share': `/chat-widget?brand=${workspace.brand.id}&tab=share`,
  automations: `/automations?brand=${workspace.brand.id}`,
  'automation-editor': `/automations/${automationId}`,
  agents: '/agents',
  'agent-editor': `/agents/${workspace.agent?.id}`,
  models: '/models',
  knowledge: `/knowledge?source=${knowledge.sourceId}&document=${knowledge.documentId}`,
  'stop-ai': '/stop-ai',
  runs: '/runs',
  'run-detail': `/runs?run=${runId}`,
  account: '/account',
});
const SIGNED_OUT = { 'sign-in': '/sign-in', 'sign-up': '/sign-up', forgot: '/forgot-password' };

async function open(page: Page, path: string, locale: Locale) {
  await page.goto(withLang(path, locale));
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const locale of LOCALES) {
  test(`HNV-24-06 HNV-24-01 · every main screen passes an automated WCAG 2.2 AA audit (${locale})`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const violations: string[] = [];

    const signedOut = await browser.newContext();
    const visitor = await signedOut.newPage();
    for (const [name, path] of Object.entries(SIGNED_OUT)) {
      await open(visitor, path, locale);
      violations.push(...(await audit(visitor, `${name} (${locale})`)));
    }
    await signedOut.close();

    const context = await browser.newContext();
    await workspace.staff.signIn(context);
    const page = await context.newPage();
    for (const [name, path] of Object.entries(screens())) {
      await open(page, path, locale);
      violations.push(...(await audit(page, `${name} (${locale})`)));
    }
    // The stop dialog, over the Stop AI page (the header's Stop AI button leads there).
    await open(page, '/overview', locale);
    await page.getByTestId('stop-ai-button').click();
    await expect(page).toHaveURL(/\/stop-ai/);
    await page.getByTestId('stop-ai-open').click();
    await expect(page.getByTestId('stop-ai-dialog')).toBeVisible();
    violations.push(...(await audit(page, `stop-ai-dialog (${locale})`)));
    // The brand editor, warning that a website taken off the list ends its chats.
    await open(page, '/brands', locale);
    await page.getByTestId('edit-brand').first().click();
    const editor = page.getByTestId('edit-brand-dialog');
    await editor.locator('#edit-brand-websites').fill('');
    await expect(editor.getByTestId('websites-removed')).toBeVisible();
    violations.push(...(await audit(page, `edit-brand-dialog (${locale})`)));
    await context.close();

    expect(violations).toEqual([]);
  });
}

test('HNV-24-06 · no sideways scrolling from 320 to 1920 px, in English and Arabic', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  await workspace.staff.signIn(context);
  const page = await context.newPage();
  const overflowing: string[] = [];
  for (const locale of LOCALES) {
    for (const [name, path] of Object.entries(screens())) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, path, locale);
      for (const width of [320, 390, 768, 1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const extra = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (extra > 1) overflowing.push(`${name} (${locale}) at ${width}px: ${extra}px too wide`);
      }
    }
  }
  await context.close();
  expect(overflowing).toEqual([]);
});

test('screenshots for visual review: overview, agent editor, knowledge and runs', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const folder = new URL('./screenshots/', import.meta.url);
  mkdirSync(folder, { recursive: true });
  const context = await browser.newContext();
  await workspace.staff.signIn(context);
  const page = await context.newPage();
  const shots = {
    overview: '/overview',
    'agent-editor': `/agents/${workspace.agent?.id}`,
    knowledge: `/knowledge?source=${knowledge.sourceId}&document=${knowledge.documentId}`,
    runs: '/runs',
  };
  for (const locale of LOCALES) {
    for (const width of [1440, 390]) {
      for (const [name, path] of Object.entries(shots)) {
        await page.setViewportSize({ width, height: 900 });
        await open(page, path, locale);
        // Sticky bars sit oddly in stitched full-page captures; show the whole page at once.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.max(900, height) });
        await page.screenshot({
          path: new URL(`${name}-${locale}-${width}.png`, folder).pathname,
          animations: 'disabled',
        });
      }
    }
  }
  await context.close();
});
