/**
 * Imports in Studio (board 18, HNV-18-01 to HNV-18-06) against the gateway, the worker and the
 * fake Chatwoot: upload a tawk.to export, review the checks and a redacted sample, import it with
 * a fresh sign-in, reconcile and approve it; roll back in Arabic; and audit every step with axe in
 * Arabic and Urdu (right to left). The export is made of the SDK's tawk.to fixtures.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { ageSessions, audit, PASSWORD, type Staff, seedWorkspace, type Workspace } from './support';

const TAWK = new URL('../../../packages/migration-sdk/test/fixtures/tawk/', import.meta.url);

/** Every fixture chat in one JSON file, the way a single tawk.to export file can hold them. */
function tawkExport(file: string): string {
  const chats = readdirSync(TAWK)
    .sort()
    .flatMap((name) => {
      const value = JSON.parse(readFileSync(new URL(name, TAWK), 'utf8')) as unknown;
      return Array.isArray(value) ? value : [value];
    });
  writeFileSync(file, JSON.stringify(chats, null, 2));
  return file;
}

interface Job {
  id: string;
  state: string;
}

async function waitFor(staff: Staff, id: string, state: string) {
  await expect
    .poll(async () => (await staff.call<Job>('GET', `/v1/admin/migrations/${id}`)).state, {
      timeout: 60_000,
    })
    .toBe(state);
}

/** Uploads the export through the API and takes it as far as the given state. */
async function seedImport(
  workspace: Workspace,
  file: string,
  until: 'ready' | 'dry_run_ready' | 'completed',
): Promise<string> {
  const { staff, brand } = workspace;
  const job = await staff.call<Job>('POST', '/v1/admin/migrations', {
    brandId: brand.id,
    source: 'tawk.to',
    file: { name: 'tawk-export.json', base64: readFileSync(file).toString('base64') },
  });
  await waitFor(staff, job.id, 'ready');
  if (until === 'ready') return job.id;
  await staff.call('POST', `/v1/admin/migrations/${job.id}/dry-run`, {});
  await waitFor(staff, job.id, 'dry_run_ready');
  if (until === 'dry_run_ready') return job.id;
  await staff.call('POST', `/v1/admin/migrations/${job.id}/start`, { duplicates: 'skip' });
  await waitFor(staff, job.id, 'completed');
  return job.id;
}

/** Full-page captures for visual review in e2e/screenshots/ (not committed). */
async function shoot(page: Page, name: string) {
  const folder = new URL('./screenshots/', import.meta.url);
  mkdirSync(folder, { recursive: true });
  const width = page.viewportSize()?.width ?? 1440;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width, height: Math.max(900, height) });
  await page.screenshot({
    path: new URL(`migration-${name}-${width}.png`, folder).pathname,
    animations: 'disabled',
  });
  await page.setViewportSize({ width, height: 900 });
}

async function jobState(page: Page, state: string) {
  await expect(page.getByTestId('migration-job')).toHaveAttribute('data-state', state, {
    timeout: 60_000,
  });
}

test('HNV-18-01 HNV-18-02 HNV-18-03 HNV-18-04 HNV-18-05 HNV-18-06 · upload a tawk.to export, check it, review a sample, import it, reconcile and approve', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ connect: true, brand: 'Northline Studio' });
  await workspace.staff.signIn(context);
  await page.goto('/migration');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Import from another tool' }),
  ).toBeVisible();
  await expect(page.getByText('No imports yet')).toBeVisible();

  // HNV-18-01: source and file.
  await page.getByTestId('new-import').click();
  const dialog = page.getByRole('dialog', { name: 'Start an import' });
  await expect(dialog.getByRole('radio', { name: 'tawk.to' })).toBeChecked();
  await dialog
    .getByLabel('Export file')
    .setInputFiles(tawkExport(testInfo.outputPath('tawk-export.json')));
  await expect(dialog.getByText(/^Chosen: tawk-export\.json/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload and check' }).click();
  await expect(dialog).toBeHidden();

  // HNV-18-02: checked before anything is imported: counts, checks, fields, limits, issues.
  await jobState(page, 'ready');
  const steps = page.getByTestId('migration-steps');
  await expect(steps.locator('[aria-current="step"]')).toHaveAttribute('data-step', '2');
  const counts = page.getByTestId('preflight-counts');
  await expect(counts.locator('[data-count="conversations"]')).toContainText('4');
  await expect(counts.locator('[data-count="messages"]')).toContainText('11');
  await expect(page.getByTestId('preflight-truncated')).toContainText(
    'Part of the export is missing',
  );
  const checks = page.getByTestId('preflight-checks');
  await expect(checks.locator('[data-status="blocked"]')).toHaveCount(0);
  await expect(checks.locator('[data-code="import_inbox"]')).toContainText(
    'It never replies, assigns or sends surveys.',
  );
  const email = page.getByTestId('preflight-fields').locator('tr[data-field="visitor.email"]');
  await expect(email).toContainText('Email, kept as not verified');
  await expect(email).toContainText('Changed on import');
  await expect(page.getByTestId('preflight-limits')).toContainText('up to 50 chats at a time');
  await expect(
    page.getByTestId('preflight-issues').locator('[data-issue="missing_time"]'),
  ).toContainText('No time');
  expect(await audit(page, 'migration preflight (en)')).toEqual([]);
  await shoot(page, 'preflight-en');

  // HNV-18-03: the dry run changes nothing and shows a redacted sample.
  await page.getByTestId('start-dry-run').click();
  await jobState(page, 'dry_run_ready');
  await expect(steps.locator('[aria-current="step"]')).toHaveAttribute('data-step', '3');
  await expect(page.getByTestId('dry-run-ready')).toContainText('4');
  await expect(page.getByTestId('dry-run-duplicates')).toContainText('0');
  await expect(page.getByTestId('dry-run-review')).toContainText('1');
  await expect(page.getByLabel('How to handle duplicates')).toHaveValue('skip');
  // Samples are redacted: Sara's phone number is hidden.
  const sample = page.getByTestId('sample-source');
  await page.getByLabel('Sample', { exact: true }).selectOption({ index: 1 });
  await expect(sample.locator('[data-message]').first()).toBeVisible();
  let found = false;
  for (let index = 0; index < 3 && !found; index += 1) {
    await page.getByLabel('Sample', { exact: true }).selectOption({ index });
    found = (await sample.textContent())?.includes('[number]') ?? false;
  }
  expect(found).toBe(true);
  await expect(sample).not.toContainText('7700');
  expect(await audit(page, 'migration dry run (en)')).toEqual([]);
  await shoot(page, 'dry-run-en');

  // HNV-18-04: starting needs a recent sign-in; the import then runs to its end.
  await ageSessions(workspace.staff.email);
  await page.getByTestId('run-import').click();
  const confirm = page.getByTestId('run-import-dialog');
  await expect(confirm).toContainText('Import 4 conversations into Northline Studio?');
  await confirm.getByRole('button', { name: 'Start import' }).click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  await reauth.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(reauth).toBeHidden();
  await jobState(page, 'completed');
  await expect(steps.locator('[aria-current="step"]')).toHaveAttribute('data-step', '4');

  // HNV-18-05: completed with issues, nothing hidden: what was not imported can be downloaded.
  await expect(page.getByTestId('import-result-title')).toHaveText(
    'Import completed with some issues',
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-rejections').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-not-imported\.csv$/);
  const csv = readFileSync((await download.path()) as string, 'utf8');
  expect(csv).toContain('attachment');
  expect(csv).toContain('binary_not_in_export');
  expect(csv).not.toContain('order-receipt');

  // HNV-18-06: reconciliation per kind, checks, what was left out, samples side by side.
  const table = page.getByTestId('report-counts');
  await expect(table.locator('tr[data-kind="conversation"] [data-column="imported"]')).toHaveText(
    '4',
  );
  await expect(
    table.locator('tr[data-kind="conversation"] [data-column="quarantined"]'),
  ).toHaveText('1');
  const reportChecks = page.getByTestId('report-checks');
  await expect(reportChecks.locator('[data-check="export_complete"]')).toHaveAttribute(
    'data-ok',
    'false',
  );
  await expect(reportChecks.locator('[data-check="nothing_sent"]')).toHaveAttribute(
    'data-ok',
    'true',
  );
  await expect(reportChecks.locator('[data-check="private_kept_private"]')).toHaveAttribute(
    'data-ok',
    'true',
  );
  await expect(
    page.getByTestId('report-quarantine').locator('tr[data-reason="binary_not_in_export"]'),
  ).toContainText('Only a link, the file is not in the export');
  await expect(page.getByTestId('sample-comparison')).toHaveAttribute('data-matches', 'true');
  await expect(page.getByTestId('sample-imported').locator('[data-message]').first()).toBeVisible();
  expect(await audit(page, 'migration reconciliation (en)')).toEqual([]);
  await shoot(page, 'reconciliation-en');

  // Approving with a failed check asks for an explicit acknowledgement.
  await page.getByTestId('approve-cutover').click();
  await expect(page.getByText('Confirm that you accept the failed checks.')).toBeVisible();
  await page.getByLabel('I accept the failed checks listed above.').check();
  await page.getByTestId('approve-cutover').click();
  await jobState(page, 'closed');
  await expect(page.getByTestId('import-result-title')).toHaveText('Import approved');

  // The list shows it with its count.
  await page.getByRole('button', { name: 'All imports' }).click();
  const row = page.getByTestId('migrations-table').locator('tr[data-migration="tawk-export.json"]');
  await expect(row).toHaveAttribute('data-state', 'closed');
  // Five conversation records: four imported, and a ticket, which is not imported.
  await expect(row).toContainText('4 of 5');
});

test('HNV-18-06 · rolling back in Arabic removes what the import created', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ connect: true });
  const id = await seedImport(
    workspace,
    tawkExport(testInfo.outputPath('tawk-export.json')),
    'completed',
  );
  await workspace.staff.signIn(context);
  await page.goto(`/migration?job=${id}&lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(
    page.getByRole('heading', { level: 1, name: 'الاستيراد من أداة أخرى' }),
  ).toBeVisible();
  await jobState(page, 'completed');
  await page.getByTestId('rollback').click();
  const dialog = page.getByTestId('rollback-dialog');
  await expect(dialog).toContainText('حذف ما أنشأه هذا الاستيراد؟');
  await dialog.getByRole('button', { name: 'حذف' }).click();
  await jobState(page, 'rolled_back');
  await expect(
    page.getByTestId('rollback-report').locator('[data-check="nothing_left"]'),
  ).toHaveAttribute('data-ok', 'true');
});

for (const locale of ['ar', 'ur'] as const) {
  test(`HNV-18-01 to HNV-18-06 · every import step passes an automated WCAG 2.2 AA audit, right to left (${locale})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const workspace = await seedWorkspace({ connect: true });
    const file = tawkExport(testInfo.outputPath('tawk-export.json'));
    const checked = await seedImport(workspace, file, 'ready');
    const sampled = await seedImport(workspace, file, 'dry_run_ready');
    const done = await seedImport(workspace, file, 'completed');
    const context = await browser.newContext();
    await workspace.staff.signIn(context);
    const page = await context.newPage();
    const violations: string[] = [];
    const overflowing: string[] = [];
    const screens: Record<string, string> = {
      list: '/migration',
      preflight: `/migration?job=${checked}`,
      'dry-run': `/migration?job=${sampled}`,
      reconciliation: `/migration?job=${done}`,
    };
    for (const [name, path] of Object.entries(screens)) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${path}${path.includes('?') ? '&' : '?'}lang=${locale}`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('h1').first()).toBeVisible();
      if (name !== 'list') await expect(page.getByTestId('migration-job')).toBeVisible();
      else await expect(page.getByTestId('migrations-table')).toBeVisible();
      violations.push(...(await audit(page, `${name} (${locale})`)));
      await shoot(page, `${name}-${locale}`);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const extra = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (extra > 1) overflowing.push(`${name} (${locale}) at ${width}px: ${extra}px too wide`);
      }
    }
    // The upload dialog.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/migration?lang=${locale}`);
    await page.getByTestId('new-import').click();
    await expect(page.getByTestId('new-import-dialog')).toBeVisible();
    violations.push(...(await audit(page, `new-import-dialog (${locale})`)));
    await context.close();
    expect(violations).toEqual([]);
    expect(overflowing).toEqual([]);
  });
}
