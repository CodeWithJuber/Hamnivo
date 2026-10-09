import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { runReasonText } from '../src/pages/automations/HistoryPanels';

beforeAll(async () => {
  await initI18n('en');
});

describe('why a run left its message out', () => {
  it('says WhatsApp’s 24-hour window in words, in every language', async () => {
    expect(runReasonText(i18next.t, 'window_closed')).toBe(
      'Message left out: WhatsApp allows only template messages 24 hours after the customer last wrote.',
    );
    expect(runReasonText(i18next.t, 'message_limit')).toBe(
      'Message left out: the daily limit of automated messages was reached.',
    );
    // A reason Studio does not know yet is shown as it came.
    expect(runReasonText(i18next.t, 'something_new')).toBe('something_new');
    for (const locale of ['ar', 'hi', 'ur']) {
      await i18next.changeLanguage(locale);
      const text = runReasonText(i18next.t, 'window_closed');
      expect(text, locale).toContain('24');
      expect(text, locale).not.toContain('Message left out');
    }
    await i18next.changeLanguage('en');
  });
});
