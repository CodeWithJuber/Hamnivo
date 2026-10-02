/**
 * Reply checks (Jev around AI replies) in a real browser, in Urdu (right to left), with an
 * accessibility audit.
 */
import { expect, test } from '@playwright/test';
import { audit, seedWorkspace } from './support';

test('reply checks start in comparison mode, take thresholds per language, publish and go live (Urdu)', async ({
  page,
  context,
}) => {
  const workspace = await seedWorkspace({ connect: true, publish: true });
  await workspace.staff.signIn(context);
  await page.goto('/checks?lang=ur');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'جوابات کی جانچ' })).toBeVisible();

  const answerCheck = page.getByRole('region', { name: 'جواب کی جانچ' });
  await expect(answerCheck).toBeVisible();
  // Every brand starts in comparison mode, and live needs a published version first.
  await expect(answerCheck.getByRole('radio', { name: 'صرف موازنہ' })).toBeChecked();
  await expect(page.getByTestId('check-versions-answer-check')).toContainText('ابھی شائع نہیں ہوا');
  // Staff see exactly what Jev is asked (in English, as Jev reads it).
  await expect(answerCheck).toContainText('How does passage_1 relate to claim_1?');
  await expect(answerCheck).toContainText('says_nothing');
  await expect(answerCheck).toContainText('ابھی کوئی جانچ ریکارڈ نہیں ہوئی۔');

  // Choosing Jev pins the evaluated version and says plainly that this server has no key.
  const provider = answerCheck.getByRole('combobox', { name: 'کون جانچتا ہے' });
  await provider.selectOption('jev');
  await expect(answerCheck.getByRole('textbox', { name: 'مقرر Jev ورژن' })).toHaveValue(
    'jev-1.13.0',
  );
  await expect(answerCheck.getByTestId('jev-not-configured')).toContainText('TYPESAFE_API_KEY');
  const violations = await audit(page, 'reply checks with Jev unconfigured (ur)');

  // The test provider runs without a key; English gets a threshold, the rest stay unevaluated.
  await provider.selectOption('mock');
  await answerCheck.getByRole('textbox', { name: 'مقرر Jev ورژن' }).fill('');
  await answerCheck.getByRole('spinbutton', { name: 'relation · انگریزی: کم از کم' }).fill('0.8');
  await answerCheck.getByRole('button', { name: 'مسودہ محفوظ کریں' }).click();
  await expect(page.getByTestId('check-versions-answer-check')).toContainText('مسودہ، ورژن 1');

  await answerCheck.getByRole('button', { name: 'مسودہ شائع کریں' }).click();
  const publish = page.getByTestId('publish-check-answer-check');
  await publish.getByRole('button', { name: 'مسودہ شائع کریں' }).click();
  await expect(publish).toBeHidden();
  await expect(page.getByTestId('check-versions-answer-check')).toContainText('شائع شدہ ورژن 1');
  await expect(
    answerCheck.getByRole('spinbutton', { name: 'relation · انگریزی: کم از کم' }),
  ).toHaveValue('0.8');

  await answerCheck.getByRole('radio', { name: 'فعال' }).click();
  await answerCheck.getByRole('button', { name: 'موڈ محفوظ کریں' }).click();
  await expect(answerCheck.getByRole('radio', { name: 'فعال' })).toBeChecked();
  const checks = await workspace.staff.call<{ items: Array<{ task: string; mode: string }> }>(
    'GET',
    `/v1/admin/brands/${workspace.brand.id}/checks`,
  );
  expect(checks.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ task: 'answer-check', mode: 'live' }),
      expect.objectContaining({ task: 'escalation', mode: 'shadow' }),
    ]),
  );

  violations.push(...(await audit(page, 'reply checks (ur)')));
  expect(violations).toEqual([]);
});
