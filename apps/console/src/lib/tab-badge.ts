/**
 * The browser tab says how many chats need you: a count in front of the title, "(3) Inbox ·
 * Hamnivo Studio", and a red dot with the count on the tab's icon. These are the plain text
 * helpers; tab-badge-page.ts draws the icon and keeps the page in step.
 */

const COUNTED = /^\((?:\d+|99\+)\)\s+/;

/** "3", or "99+" when there are more than 99. Empty when nothing needs attention. */
export function countLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** The text on the icon's dot: one or two characters at most, "9+" for ten or more. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** A tab title with the count in front (and any earlier count taken off first). */
export function titleWithCount(title: string, count: number): string {
  const plain = title.replace(COUNTED, '');
  const label = countLabel(count);
  return label ? `(${label}) ${plain}` : plain;
}

/** The title the tab should have now, or null when it already has it. */
export function reconcileTitle(current: string, count: number): string | null {
  const wanted = titleWithCount(current, count);
  return wanted === current ? null : wanted;
}
