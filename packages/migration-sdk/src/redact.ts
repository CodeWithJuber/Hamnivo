const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Seven or more digits in any script, with the usual separators: phone and card numbers.
const NUMBER = /\+?\p{Nd}(?:[\p{Nd}\s().-]{5,}\p{Nd})/gu;
const LINK_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;

/**
 * Masks email addresses, phone and card numbers and link parameters in sample text (the dry run
 * shows redacted samples, HNV-18-03). The rest of the text is kept so reviewers can check
 * language, direction and formatting.
 */
export function redact(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(LINK_QUERY, '$1')
    .replace(NUMBER, (match) =>
      match.replace(/[^\p{Nd}]/gu, '').length >= 7 ? '[number]' : match,
    );
}

/**
 * Chatwoot turns `(mention://user/…)` links in private notes into notifications for staff.
 * Imported text keeps the name but loses the link, so history never notifies anyone.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/\[([^\]]{1,120})\]\(mention:\/\/(?:user|team)\/\d+\/[^)]*\)/g, '$1');
}
