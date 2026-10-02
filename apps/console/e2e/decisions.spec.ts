/**
 * Decision rules (board 12) and answer caching (board 25) in a real browser, in right-to-left
 * languages, with accessibility audits. Each test is named after the UX states it covers.
 */
import { expect, type Page, test } from '@playwright/test';
import { audit, customerAsks, seedWorkspace, waitForRun } from './support';

interface RecordPage {
  items: Array<{ trigger: string; mode: string; applied: boolean; status: string }>;
}

const result = (page: Page) => page.getByTestId('test-result');

async function tryMessage(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'الرسالة' }).fill(message);
  await page.getByRole('button', { name: 'جرّب', exact: true }).click();
}

test('HNV-12-01 HNV-12-02 HNV-12-03 HNV-12-05 · edit, publish and try a routing rubric in Arabic, then shadow real conversations', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/decisions?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'قواعد القرار' })).toBeVisible();

  // A team that handles billing in English and Arabic (U07). It is an inbox team, created in the
  // brand's workspace; routing adds its topics and languages for this brand.
  await page.getByRole('textbox', { name: 'اسم الفريق' }).fill('Billing team');
  await page.getByRole('textbox', { name: 'المواضيع', exact: true }).fill('billing');
  await page.getByRole('checkbox', { name: 'الإنجليزية' }).click();
  await page.getByRole('checkbox', { name: 'العربية' }).click();
  await page.getByRole('button', { name: 'إضافة فريق' }).click();
  const team = page.getByTestId('routing-team').filter({ hasText: 'Billing team' });
  await expect(team).toContainText('الإنجليزية');
  const inboxTeams = await workspace.staff.call<{ items: Array<{ name: string }> }>(
    'GET',
    '/v1/admin/teams',
  );
  expect(inboxTeams.items.map((item) => item.name)).toContain('Billing team');

  // Its routing is edited in place: it can also serve Urdu with translation.
  await team.getByRole('button', { name: 'تعديل التوجيه لفريق Billing team' }).click();
  const routing = page.getByTestId('team-routing-dialog');
  await routing
    .getByRole('group', { name: 'لغات يخدمها الفريق بالترجمة' })
    .getByRole('checkbox', { name: 'الأردية', exact: true })
    .click();
  const dialogViolations = await audit(page, 'team routing dialog (ar)');
  await routing.getByRole('button', { name: 'حفظ التوجيه' }).click();
  await expect(routing).toBeHidden();
  await expect(team).toContainText('بالترجمة: الأردية');

  // The rubric: a malformed topic key is refused before anything goes live (HNV-12-01).
  await page.getByRole('combobox', { name: 'من يقترح الفريق' }).selectOption('mock');
  const first = page.getByRole('group', { name: 'الموضوع 1' });
  await first.getByRole('textbox', { name: 'المفتاح' }).fill('Billing!');
  await first.getByRole('textbox', { name: 'ما يشمله' }).fill('Payments, invoices and refunds');
  await first
    .getByRole('textbox', { name: 'كلمات للقواعد الثابتة' })
    .fill('refund, invoice, استرداد');
  await page.getByRole('button', { name: 'إضافة موضوع' }).click();
  const second = page.getByRole('group', { name: 'الموضوع 2' });
  await second.getByRole('textbox', { name: 'المفتاح' }).fill('shipping');
  await second.getByRole('textbox', { name: 'ما يشمله' }).fill('Delivery and parcels');
  await second.getByRole('textbox', { name: 'كلمات للقواعد الثابتة' }).fill('delivery, parcel');
  await page.getByRole('spinbutton', { name: 'الإنجليزية' }).fill('0.7');
  await page.getByRole('spinbutton', { name: 'العربية' }).fill('0.7');
  await page.getByRole('button', { name: 'حفظ المسودة' }).click();
  await expect(first.getByRole('textbox', { name: 'المفتاح' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByTestId('action-error').first()).toBeVisible();
  await expect(page.getByTestId('rubric-versions')).not.toContainText('المسودة');

  await first.getByRole('textbox', { name: 'المفتاح' }).fill('billing');
  await page.getByRole('button', { name: 'حفظ المسودة' }).click();
  await expect(page.getByTestId('rubric-versions')).toContainText('المسودة، الإصدار 1');

  await page.getByRole('button', { name: 'نشر المسودة' }).click();
  const publish = page.getByTestId('publish-rubric-dialog');
  await publish.getByRole('button', { name: 'نشر المسودة' }).click();
  await expect(publish).toBeHidden();
  await expect(page.getByTestId('rubric-versions')).toContainText('الإصدار المنشور 1');

  // HNV-12-02: a complete typed result, with the team it routes to.
  await tryMessage(page, 'I want a refund for my invoice');
  await expect(result(page)).toHaveAttribute('data-status', 'decided');
  await expect(result(page)).toContainText('Billing team');
  await expect(result(page).getByTestId('test-final')).toContainText('من Jev');
  await expect(result(page).getByTestId('test-confidence')).toContainText('90');

  // HNV-12-03: not sure enough → the fixed rules decide, with no confidence made up for them.
  await tryMessage(page, 'مرحبا، عندي سؤال');
  await expect(result(page)).toHaveAttribute('data-status', 'abstained');
  await expect(result(page)).toContainText('لم يكن Jev متأكدًا');
  await expect(result(page).getByTestId('test-final')).toContainText('من القواعد الثابتة');

  // A request for a person is never overridden.
  await tryMessage(page, 'I want to talk to a person please');
  await expect(result(page)).toContainText('تطلب الرسالة التحدث إلى شخص');

  const violations = [...dialogViolations, ...(await audit(page, 'decisions (ar)'))];

  // Every brand starts in shadow mode (J02): real conversations record Jev next to the fixed
  // rules, and no team is assigned from Jev's choice.
  await expect(page.getByRole('radio', { name: 'مقارنة فقط' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'حفظ الوضع' })).toBeDisabled();
  // Live is offered, and saving becomes possible once it is chosen.
  await page.getByRole('radio', { name: 'مُفعَّل' }).click();
  await expect(page.getByRole('button', { name: 'حفظ الوضع' })).toBeEnabled();
  await page.getByRole('radio', { name: 'مقارنة فقط' }).click();
  await customerAsks(workspace.brand.widgetId, 'Where is the refund for my invoice?');
  await waitForRun(workspace.staff);
  await expect
    .poll(
      async () => {
        const records = await workspace.staff.call<RecordPage>(
          'GET',
          `/v1/admin/brands/${workspace.brand.id}/decisions/team-routing/records?limit=20`,
        );
        return records.items.filter((r) => r.trigger === 'new_conversation').length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await page.reload();
  const shadow = page.getByTestId('decision-record').filter({ hasText: 'محادثة جديدة' }).first();
  await expect(shadow).toContainText('مقارنة فقط');
  await expect(shadow).toContainText('Billing team');
  await expect(page.getByTestId('decision-experiment')).toBeVisible();
  violations.push(...(await audit(page, 'decisions records (ar)')));
  expect(violations).toEqual([]);
});

test('HNV-25-01 HNV-25-02 HNV-25-04 HNV-25-05 HNV-25-06 · cache answers in Urdu: turn on, inspect, reuse and stop reuse', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/caching?lang=ur');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'جوابات کی کیشنگ' })).toBeVisible();
  await expect(page.getByTestId('cache-health')).toHaveAttribute('data-health', 'up');
  await expect(page.getByTestId('never-cached')).toContainText('ذاتی معلومات');

  // HNV-25-01: exact answers are off until someone turns them on.
  const exact = page.getByRole('checkbox', { name: 'ہوبہو جوابات استعمال کریں' });
  await expect(exact).not.toBeChecked();
  await exact.click();
  await page.getByRole('button', { name: 'پالیسی محفوظ کریں' }).click();
  await expect(page.getByTestId('policy-version')).toContainText('پالیسی ورژن 1');

  // HNV-25-04: personal data always bypasses, and nothing is shown or stored.
  const inspect = async (question: string) => {
    await page.getByRole('textbox', { name: 'سوال', exact: true }).fill(question);
    await page.getByRole('button', { name: 'جانچیں' }).click();
  };
  await inspect('Where is order NL-1048? My email is sara@example.com');
  const card = page.getByTestId('cache-inspection');
  await expect(card).toHaveAttribute('data-status', 'bypass');
  await expect(card).toContainText('سوال میں ذاتی معلومات ہیں۔');
  await expect(card.getByTestId('cache-preview')).toHaveCount(0);

  await inspect('What are your opening hours?');
  await expect(card).toHaveAttribute('data-status', 'miss');

  // HNV-25-02: after a visitor asks it first, the same question is answered from the cache.
  await customerAsks(workspace.brand.widgetId, 'What are your opening hours?');
  await waitForRun(workspace.staff);
  await expect
    .poll(
      async () => {
        await inspect('What are your opening hours?');
        return card.getAttribute('data-status');
      },
      { timeout: 30_000 },
    )
    .toBe('hit');
  await expect(card.getByTestId('cache-preview')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('cache-entry')).toHaveAttribute('data-state', 'active');
  const violations = await audit(page, 'caching (ur)');

  // HNV-25-05: stop reuse after a correction; reads stop at once.
  await page.getByRole('textbox', { name: 'وجہ' }).fill('Opening hours changed');
  await page.getByRole('button', { name: 'دوبارہ استعمال روکیں' }).click();
  const confirm = page.getByTestId('invalidate-dialog');
  await confirm.getByRole('button', { name: 'دوبارہ استعمال روکیں' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('cache-invalidated')).toContainText('1');
  await expect(page.getByTestId('cache-entry')).toHaveAttribute('data-state', 'invalidated');
  await inspect('What are your opening hours?');
  await expect(card).not.toHaveAttribute('data-status', 'hit');

  // HNV-25-06 (K10): counts only, per tier and language.
  await expect(page.getByTestId('cache-metrics')).toContainText('ہوبہو جوابات');
  violations.push(...(await audit(page, 'caching after invalidation (ur)')));
  expect(violations).toEqual([]);
});
