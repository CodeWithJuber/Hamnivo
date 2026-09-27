import { formatDateTime, formatMoney, money } from '@hamnivo/domain/commerce';

/**
 * Amounts and times in the customer's language (U06): exact minor units in, the locale's own
 * digits and separators out, with the currency always shown. Times show their zone.
 */
export function price(amountMinor: string | null | undefined, currency: string, locale: string) {
  if (amountMinor === null || amountMinor === undefined) return '';
  try {
    return formatMoney(money(BigInt(amountMinor), currency), locale);
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

export function time(iso: string | null | undefined, locale: string) {
  if (!iso) return '';
  try {
    return formatDateTime(new Date(iso), locale, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      part: 'time',
    });
  } catch {
    return iso;
  }
}
