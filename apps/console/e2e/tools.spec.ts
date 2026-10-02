/**
 * Tools and permissions (board 13), the agent's tool grants and test room (board 11) and AI
 * actions in the inbox (boards 10 and 13) in a real browser against the real gateway and worker:
 * keyboard use, phone width, right to left and accessibility audits. Each test is named after the
 * UX states it covers.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  ageSessions,
  audit,
  customerAsks,
  PASSWORD,
  type Staff,
  seedWorkspace,
  tabTo,
  type Workspace,
} from './support';

interface Tool {
  id: string;
  title: string;
}

async function addTool(staff: Staff, brandId: string, builtin: string): Promise<Tool> {
  return staff.call<Tool>('POST', '/v1/admin/tools', { brandId, builtin });
}

/** Publishes the brand's agent with these tool grants (through the API, as set-up). */
async function grant(workspace: Workspace, toolIds: string[]) {
  const agentId = workspace.agent?.id ?? '';
  const detail = await workspace.staff.call<{
    published: { config: Record<string, unknown> } | null;
    draft: { config: Record<string, unknown> } | null;
  }>('GET', `/v1/admin/agents/${agentId}`);
  const config = detail.draft?.config ?? detail.published?.config ?? {};
  await workspace.staff.call('PUT', `/v1/admin/agents/${agentId}/draft`, {
    config: {
      ...config,
      tools: {
        maxCallsPerRun: 4,
        maxAutopilotPerConversation: 5,
        grants: toolIds.map((toolId) => ({ toolId, autopilot: false })),
      },
    },
  });
  await workspace.staff.call('POST', `/v1/admin/agents/${agentId}/publish`, {});
}

/** No sideways page scroll; on failure, names the elements that reach past the screen edge. */
async function noSidewaysScroll(page: Page) {
  const { overflow, wide } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.body.querySelectorAll('*')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > width + 1 || box.left < -1);
      })
      .slice(0, 8)
      .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
    return { overflow: document.documentElement.scrollWidth - width, wide };
  });
  expect(overflow, `wider than the screen: ${wide.join(' | ')}`).toBeLessThanOrEqual(0);
}

test('HNV-13-01 HNV-13-02 HNV-13-04 · add a tool, open its inspector by keyboard and choose who approves; phone width and audits', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/tools');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Tools and permissions' }),
  ).toBeVisible();
  await expect(page.getByTestId('tools-agent')).toContainText('Published v1');

  // Add the address tool from the list of built-in tools.
  await page.getByTestId('add-tool').click();
  const dialog = page.getByTestId('add-tool-dialog');
  await dialog
    .getByRole('combobox', { name: 'Tool' })
    .selectOption({ label: 'Change delivery address (demo)' });
  await expect(dialog).toContainText('The customer approves the exact change first.');
  const violations = await audit(page, 'add tool dialog');
  await dialog.getByRole('button', { name: 'Add tool' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId('tools-table').locator('tr[data-tool="demo_update_address"]');
  await expect(row).toContainText('Changes data');
  await expect(row).toContainText('Customer approves');

  // Open the inspector by keyboard; the permission reads in words, with an icon.
  const opener = row.getByRole('button', { name: 'Open Change delivery address' });
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('tool-sheet');
  await expect(sheet.getByRole('heading', { name: 'Change delivery address' })).toBeVisible();
  await expect(sheet).toContainText('The customer approves the exact change in the chat first.');
  violations.push(...(await audit(page, 'tool inspector')));

  // Money and irreversible actions can never run without approval: the switch is not offered.
  await sheet.getByRole('radio', { name: 'A team member' }).click();
  await sheet.getByRole('combobox', { name: 'What it can do' }).selectOption('money');
  await expect(sheet.getByRole('checkbox', { name: 'Can run without approval' })).toBeDisabled();
  await sheet.getByRole('combobox', { name: 'What it can do' }).selectOption('write');
  await sheet.getByRole('radio', { name: 'The customer' }).click();

  await sheet.getByRole('checkbox', { name: 'Can run without approval' }).click();
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet).toContainText('Revision 2');
  await expect(row).toContainText('Runs automatically');

  // Escape closes the inspector and returns focus to the row that opened it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();

  // Phone width: nothing spills sideways; the table scrolls inside its own region.
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page);
  violations.push(...(await audit(page, 'tools page at 390 px')));

  // Right to left.
  await page.goto('/tools?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'الأدوات والصلاحيات' })).toBeVisible();
  await expect(page.getByTestId('tools-table')).toContainText('يعمل تلقائيًا');
  await noSidewaysScroll(page);
  violations.push(...(await audit(page, 'tools page (ar)')));
  expect(violations).toEqual([]);
});

test('HNV-11-03 HNV-11-04 HNV-11-05 · grant a tool, see the draft against the published version, publish only after the required test passes', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await addTool(workspace.staff, workspace.brand.id, 'demo_update_address');
  await workspace.staff.signIn(context);
  await page.goto(`/agents/${workspace.agent?.id}`);
  await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();

  // A test suite marked required (the example cases are filled in).
  const room = page.getByTestId('simulations');
  await room.getByRole('button', { name: 'Add a test suite' }).click();
  const suiteDialog = page.getByTestId('suite-dialog');
  await suiteDialog.getByRole('textbox', { name: 'Name' }).fill('Release checks');
  await suiteDialog
    .getByRole('checkbox', { name: 'Publishing waits until the draft passes' })
    .click();
  await suiteDialog.getByRole('button', { name: 'Save suite' }).click();
  await expect(suiteDialog).toBeHidden();
  await expect(room.locator('[data-suite="Release checks"]')).toContainText(
    'Required before publishing',
  );

  // Grant the tool in a new draft.
  await page.getByRole('checkbox', { name: 'Change delivery address' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('save-state')).toHaveText('Draft saved as version 2.');

  // HNV-11-05: publishing waits for the required test; the live version stays as it was.
  await page.getByTestId('publish-button').click();
  const publish = page.getByTestId('publish-dialog');
  await publish.getByRole('button', { name: 'Publish' }).click();
  await expect(publish).toContainText(
    'Run the required simulation “Release checks” on this draft before publishing.',
  );
  await expect(publish).toContainText('The live version didn’t change.');
  await publish.getByRole('button', { name: 'Cancel' }).click();

  // HNV-11-04: replay against the draft and the published version (test only, nothing sent).
  const suite = room.locator('[data-suite="Release checks"]');
  await suite.getByRole('button', { name: 'Run Release checks on this draft' }).click();
  const results = suite.getByTestId('simulation-results');
  await expect(results).toHaveAttribute('data-status', 'passed', { timeout: 30_000 });
  await expect(results).toContainText('Test only: nothing was sent');
  const changed = results.locator('[data-case="address-change"]');
  await expect(changed.getByTestId('case-changes')).toContainText(
    'New action: demo_update_address (approval)',
  );
  await expect(changed).toContainText('Asks for approval');
  const violations = await audit(page, 'test room results');

  await page.getByTestId('publish-button').click();
  await publish.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('save-state')).toHaveText('Version 2 is live.');
  expect(violations).toEqual([]);
});

test('HNV-13-02 HNV-13-05 HNV-10-03 · staff approve a money action after a fresh sign-in; a handoff carries its packet', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const credit = await addTool(workspace.staff, workspace.brand.id, 'demo_issue_credit');
  await grant(workspace, [credit.id]);
  const conversation = await customerAsks(
    workspace.brand.widgetId,
    'Please issue a store credit of 500 AED for order NL-3001',
  );
  await expect
    .poll(
      async () => {
        const page = await workspace.staff.call<{ items: Array<{ state: string }> }>(
          'GET',
          `/v1/inbox/conversations/${conversation.id}/actions`,
        );
        return page.items[0]?.state ?? 'none';
      },
      { timeout: 30_000 },
    )
    .toBe('awaiting_approval');

  await workspace.staff.signIn(context);
  await page.goto(`/inbox/${conversation.id}`);
  const action = page
    .getByTestId('conversation-actions')
    .locator('[data-action="demo_issue_credit"]');
  await expect(action).toContainText('Issue a store credit of AED 5.00 for order NL-3001');
  await expect(action).toContainText('A team member approves this, after a fresh sign-in.');
  const violations = await audit(page, 'inbox AI actions');

  // Money needs a sign-in within the step-up window: the approval asks for it, then carries on.
  await ageSessions(workspace.staff.email);
  await action.getByRole('button', { name: 'Approve' }).click();
  const reauth = page.getByTestId('reauth-dialog');
  await expect(reauth).toHaveAttribute('data-reason', 'step-up');
  await reauth.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await reauth.getByRole('button', { name: 'Confirm' }).click();
  await expect(action).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(action).toContainText('Receipt: done');

  violations.push(...(await audit(page, 'inbox after approval')));

  // HNV-10-03: a customer who asks for a person; the handoff summary says why, from records.
  const handedOver = await customerAsks(
    workspace.brand.widgetId,
    'I want to talk to a person about order NL-3001',
  );
  await expect
    .poll(
      async () =>
        (
          await workspace.staff.call<{ items: unknown[] }>(
            'GET',
            `/v1/inbox/conversations/${handedOver.id}/handoff-packets`,
          )
        ).items.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await page.goto(`/inbox/${handedOver.id}`);
  const packet = page.getByTestId('handoff-packet');
  await expect(packet).toContainText('The customer asked to talk to a person');
  await expect(packet).toContainText('“I want to talk to a person about order NL-3001”');
  await expect(packet).toContainText('Customer request: asked for a person');
  violations.push(...(await audit(page, 'handoff summary')));
  expect(violations).toEqual([]);
});
