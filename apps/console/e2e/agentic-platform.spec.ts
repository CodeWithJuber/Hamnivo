import { expect, test } from '@playwright/test';
import { seedWorkspace } from './support';

test('workflow, connector catalogue and agency directory use real tenant APIs', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/workflows');
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByLabel('Starting template').selectOption('support');
  await page.locator('#workflow-name').fill('Customer support flow');
  await page.getByLabel('Coordinator agent').selectOption(workspace.agent?.id ?? '');
  await page.screenshot({ path: '/tmp/hamnivo-workflow-editor-desktop.png', fullPage: false });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: /Customer support flow/ }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: /Customer support flow/ })).toBeVisible();
  await page.screenshot({ path: '/tmp/hamnivo-workflows-desktop.png', fullPage: false });
  await page.goto('/connectors');
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  await page.getByText('Create WHMCS', { exact: true }).click();
  await expect(page.getByLabel('API secret', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByRole('group', { name: 'Allowed actions' })).toBeVisible();
  await workspace.staff.call('PATCH', '/v1/admin/agency', { enabled: true });
  await page.goto('/agency');
  await expect(page.getByRole('heading', { name: 'Agency clients' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Independent client');
  await page.getByLabel('Workspace address', { exact: true }).fill(`client-${Date.now()}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Independent client' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('appearance remains a draft until publish and the real widget preview supports mobile RTL', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto(`/chat-widget?brand=${workspace.brand.id}&tab=look`);
  const before = await workspace.staff.call<{ configVersion: number }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/appearance`,
  );
  await page.locator('#look-colour').fill('#0B5D3B');
  await page.locator('#look-greeting-en').fill('Welcome to our support desk.');
  await page.locator('#look-theme').selectOption('dark');
  await page.locator('#look-header').selectOption('plain');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  const draft = await workspace.staff.call<{ configVersion: number; draftAppearance: unknown }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/appearance`,
  );
  expect(draft.configVersion).toBe(before.configVersion);
  expect(draft.draftAppearance).toBeTruthy();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const published = await workspace.staff.call<{ configVersion: number }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/appearance`,
  );
  expect(published.configVersion).toBeGreaterThan(before.configVersion);
  await page.getByRole('button', { name: 'Open real widget preview', exact: true }).click();
  const preview = page.frameLocator('[data-testid="live-widget-preview"]');
  await expect(
    preview.getByRole('heading', { name: workspace.brand.name, exact: true }),
  ).toBeVisible();
  // The real chat takes the brand's dark and plain header from the draft, before it is published.
  await expect(preview.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(preview.locator('[data-header="plain"]')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#look-preview-lang').selectOption('ar');
  await expect(preview.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('live-widget-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/hamnivo-widget-preview-mobile-rtl.png', fullPage: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});

test('workflow steps select named tools and specialists for the chosen brand', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const tool = await workspace.staff.call<{ id: string; title: string }>(
    'POST',
    '/v1/admin/tools',
    { brandId: workspace.brand.id, builtin: 'order_status' },
  );
  const coordinator = await workspace.staff.call<{
    published: { config: Record<string, unknown> };
  }>('GET', `/v1/admin/agents/${workspace.agent?.id}`);
  const specialist = await workspace.staff.call<{ agent: { id: string } }>(
    'POST',
    '/v1/admin/agents',
    {
      brandId: workspace.brand.id,
      name: 'Billing specialist',
      config: coordinator.published.config,
    },
  );
  await workspace.staff.call('POST', `/v1/admin/agents/${specialist.agent.id}/publish`, {});
  await workspace.staff.signIn(context);
  await page.goto('/workflows');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#workflow-name').fill('Named resources');
  await page.getByLabel('Coordinator agent').selectOption(workspace.agent?.id ?? '');
  await page.getByLabel('Step type').first().selectOption('tool_action');
  await page.getByLabel('Action tool', { exact: true }).selectOption({ label: tool.title });
  await expect(page.getByLabel('Action tool', { exact: true })).toHaveValue(tool.id);
  await page.getByRole('button', { name: 'Add step', exact: true }).click();
  await page.getByLabel('Step type').nth(1).selectOption('delegate');
  await page
    .getByLabel('Specialist', { exact: true })
    .selectOption({ label: 'Internal agent: Billing specialist' });
  await expect(page.getByLabel('Specialist', { exact: true })).toHaveValue(
    `agent:${specialist.agent.id}`,
  );
  await page.getByText('Run limits', { exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Billing specialist', exact: true }),
  ).toBeChecked();
  const definition = JSON.parse(await page.locator('#workflow-definition').inputValue());
  expect(definition.allowedDelegateAgentIds).toContain(specialist.agent.id);
  expect(definition.budget.maxDelegations).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: '/tmp/hamnivo-workflow-named-resources.png', fullPage: true });
});
