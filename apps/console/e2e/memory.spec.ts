/**
 * Customer memory in Studio (board 15: HNV-15-02 to 15-06): provenance, a disagreeing value under
 * review, a correction with a reason, deletion with its receipt, erasure and export, access
 * denied, and right-to-left layout, in a real browser against the gateway and worker.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { audit, SHOP, Staff, seedWorkspace, stack, verifyEmail, type Workspace } from './support';

/** Turns customer memory on for the brand's assistant and publishes it. */
async function useMemory({ staff, agent }: Workspace) {
  const detail = await staff.call<{
    published: { config: Record<string, unknown> & { memory?: object } };
  }>('GET', `/v1/admin/agents/${agent?.id}`);
  const config = detail.published.config;
  await staff.call('PUT', `/v1/admin/agents/${agent?.id}/draft`, {
    config: { ...config, memory: { ...config.memory, enabled: true } },
  });
  await staff.call('POST', `/v1/admin/agents/${agent?.id}/publish`, {});
}

/** A customer in the chat window, through the widget API. */
class Customer {
  private conversationId = '';
  private constructor(
    private readonly token: string,
    readonly id: string,
  ) {}

  static async open(widgetId: string): Promise<Customer> {
    const response = await fetch(`${stack().apiBase}/v1/widget/sessions`, {
      method: 'POST',
      headers: { origin: stack().widgetOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ widgetId, hostOrigin: SHOP, locale: 'en' }),
    });
    expect(response.status, 'widget session').toBe(201);
    const session = (await response.json()) as { accessToken: string; principal: { id: string } };
    return new Customer(session.accessToken, session.principal.id);
  }

  private async call(path: string, body: unknown) {
    const response = await fetch(`${stack().apiBase}${path}`, {
      method: 'POST',
      headers: {
        origin: stack().widgetOrigin,
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.ok, `${path} → ${response.status}`).toBe(true);
    return response.json() as Promise<{ id: string }>;
  }

  agree() {
    return this.call('/v1/widget/memory/consent', {
      state: 'granted',
      noticeVersion: 'memory-notice/1',
    });
  }

  async say(text: string) {
    if (!this.conversationId) {
      const started = await this.call('/v1/widget/conversations', {
        clientMessageId: randomUUID(),
        firstMessage: text,
      });
      this.conversationId = started.id;
      return;
    }
    await this.call(`/v1/widget/conversations/${this.conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text }],
    });
  }
}

type Summary = { customer: { id: string }; active: number; pending: number };

/** Waits until staff see the customer's memory with these counts (it is written in the background). */
async function remembered(staff: Staff, customerId: string, active: number, pending: number) {
  await expect
    .poll(
      async () => {
        const list = await staff.call<{ items: Summary[] }>('GET', '/v1/admin/memory/customers');
        const found = list.items.find((item) => item.customer.id === customerId);
        return found ? [found.active, found.pending] : null;
      },
      { timeout: 30_000 },
    )
    .toEqual([active, pending]);
}

test('HNV-15-02 HNV-15-03 HNV-15-04 HNV-15-05 · review, correct, delete, export and erase a customer’s memory', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await useMemory(workspace);
  const customer = await Customer.open(workspace.brand.widgetId);
  await customer.agree();
  await customer.say('Please answer in Urdu from now on. Email me the invoice.');
  await remembered(workspace.staff, customer.id, 2, 0);
  await customer.say('Actually, please answer in English.');
  await remembered(workspace.staff, customer.id, 2, 1);

  await workspace.staff.signIn(context);
  await page.goto('/memory');
  await expect(page.getByRole('heading', { level: 1, name: 'Customer memory' })).toBeVisible();
  const row = page.getByTestId('memory-customers').locator(`tr[data-customer="${customer.id}"]`);
  await expect(row).toContainText('Anonymous customer');
  await expect(row).toContainText('Memory on');
  await expect(row).toContainText('1 to review');
  expect(await audit(page, 'memory list')).toEqual([]);

  await row.getByRole('link', { name: 'Anonymous customer' }).click();
  await expect(page.getByTestId('consent-line')).toContainText('Agreed on');

  // HNV-15-03: the newer value waits for review; neither is used until someone decides.
  const conflict = page.getByTestId('memory-conflict');
  await expect(conflict).toContainText('A newer message may replace “Preferred language”');
  await conflict.getByRole('button', { name: 'Compare' }).click();
  const panel = page.getByTestId('memory-panel');
  await expect(panel.getByRole('heading', { name: 'Preferred language' })).toBeFocused();
  const compare = panel.getByTestId('memory-compare');
  await expect(compare).toContainText('Urdu');
  await expect(compare).toContainText('English');
  expect(await audit(page, 'memory review')).toEqual([]);

  await panel.getByRole('button', { name: 'Confirm new value' }).click();
  const confirm = page.getByTestId('memory-confirm-dialog');
  await confirm.getByRole('button', { name: 'Confirm new value' }).click();
  await expect(confirm.getByText('Enter a reason.')).toBeVisible();
  await confirm.getByLabel('Reason').fill('The customer confirmed in the chat');
  await confirm.getByRole('button', { name: 'Confirm new value' }).click();
  await expect(confirm).toBeHidden();
  await expect(conflict).toBeHidden();
  await expect(panel.getByTestId('memory-value')).toHaveText('English');
  await expect(panel.getByTestId('memory-history')).toContainText('Urdu');

  // HNV-15-02 and 15-04: where it came from, and a correction with its reason.
  await page
    .getByTestId('memory-items-preferences')
    .getByRole('button', { name: 'Contact preference' })
    .click();
  await expect(panel.getByRole('heading', { name: 'Contact preference' })).toBeFocused();
  await expect(panel).toContainText('Customer message');
  await expect(panel).toContainText('From a customer message');
  await expect(panel).toContainText('This customer, in every chat with this brand');
  await panel.getByLabel('New value').fill('WhatsApp');
  await panel.getByLabel('Reason for correction').fill('Asked by phone to use WhatsApp');
  await panel.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByTestId('memory-status')).toContainText('Correction saved.');
  await expect(panel.getByTestId('memory-value')).toHaveText('WhatsApp');
  await expect(panel).toContainText('Asked by phone to use WhatsApp');
  await expect(panel.getByTestId('memory-history')).toContainText('Email');

  // HNV-15-05: the delete dialog says what stays; the receipt completes once indexes are cleared.
  await panel.getByRole('button', { name: 'Delete' }).click();
  const remove = page.getByTestId('memory-delete-dialog');
  await expect(remove.getByRole('heading', { name: 'Delete this memory?' })).toBeVisible();
  await expect(remove).toContainText('an audit record will be kept');
  expect(await audit(page, 'delete dialog')).toEqual([]);
  await remove.getByLabel('Reason').fill('Customer asked us to forget it');
  await remove.getByRole('button', { name: 'Remove from future use' }).click();
  await expect(remove).toBeHidden();
  const notice = page.getByTestId('deletion-notice');
  await expect(notice).toContainText('Removed from active use.');
  await expect(notice).toHaveAttribute('data-deletion-status', 'completed', { timeout: 30_000 });
  await expect(notice).toContainText('Indexes and caches are cleared.');
  await expect(page.getByTestId('memory-deletions')).toContainText('Staff request');
  await expect(page.getByTestId('memory-items-preferences')).not.toContainText('WhatsApp');

  // Export for an access request.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`customer-memory-${customer.id}.json`);
  const exported = JSON.parse(readFileSync((await download.path()) ?? '', 'utf8'));
  expect(exported.customer.id).toBe(customer.id);
  expect(exported.records.map((r: { value: string }) => r.value)).toContain('English');

  // Erase everything, and turn memory off.
  await page.getByRole('button', { name: 'Erase all memory' }).click();
  const erase = page.getByTestId('memory-erase-dialog');
  await erase.getByLabel('Reason').fill('Erasure request by email');
  await expect(
    erase.getByRole('checkbox', { name: 'Also turn memory off for this customer' }),
  ).toBeChecked();
  await erase.getByRole('button', { name: 'Erase all memory' }).click();
  await expect(erase).toBeHidden();
  await expect(notice).toContainText('All memory about this customer was erased.');
  await expect(notice).toHaveAttribute('data-deletion-status', 'completed', { timeout: 30_000 });
  await expect(page.getByTestId('consent-line')).toContainText('Turned off on');
  await expect(page.getByTestId('memory-items-preferences')).toHaveCount(0);
  expect(await audit(page, 'after erasure')).toEqual([]);
});

test('HNV-15-02 · the memory page reads right to left in Arabic and Urdu', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await useMemory(workspace);
  const customer = await Customer.open(workspace.brand.widgetId);
  await customer.agree();
  await customer.say('Please answer in Urdu from now on.');
  await remembered(workspace.staff, customer.id, 1, 0);
  await workspace.staff.signIn(context);

  await page.goto(`/memory/${customer.id}?lang=ar`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'ذاكرة العملاء' })).toBeVisible();
  await page
    .getByTestId('memory-items-preferences')
    .getByRole('button', { name: 'اللغة المفضلة' })
    .click();
  await expect(page.getByTestId('memory-panel')).toContainText('رسالة من العميل');
  expect(await audit(page, 'memory rtl ar')).toEqual([]);

  await page.goto(`/memory?lang=ur`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'کسٹمر میموری' })).toBeVisible();
  await expect(page.getByTestId('memory-customers')).toContainText('میموری آن');
  expect(await audit(page, 'memory rtl ur')).toEqual([]);
});

test('HNV-15-06 · without permission to see customer memory, Studio says so and hides it', async ({
  browser,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  const roles = await workspace.staff.call<{ items: Array<{ id: string; key: string }> }>(
    'GET',
    '/v1/admin/roles',
  );
  const agentRole = roles.items.find((role) => role.key === 'agent');
  const member = await Staff.signUp('Omar Agent', 'agent');
  const invitation = await workspace.staff.call<{ token: string }>(
    'POST',
    '/v1/admin/invitations',
    {
      email: member.email,
      roleId: agentRole?.id,
      scope: { type: 'tenant' },
      grantExpiresAt: null,
    },
  );
  await verifyEmail(member.email);
  await member.call('POST', '/v1/invitations/accept', { token: invitation.token });
  member.tenantId = workspace.staff.tenantId;

  const context = await browser.newContext();
  await member.signIn(context);
  const page = await context.newPage();
  await page.goto('/memory');
  await expect(page.getByTestId('forbidden')).toContainText('You can’t see customer memory');
  // The AI assistant pages this person can open do not include customer memory.
  const pages = page.getByRole('navigation', { name: 'AI assistant pages' });
  await expect(pages).toBeVisible();
  await expect(pages).not.toContainText('Customer memory');
  await expect(page.getByRole('navigation', { name: 'Studio', exact: true })).not.toContainText(
    'Customer memory',
  );
  expect(await audit(page, 'memory forbidden')).toEqual([]);
  await context.close();
});
