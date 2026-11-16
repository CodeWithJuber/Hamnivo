/**
 * How messages sit together in the conversation: replies one sender wrote in a row share one
 * name and picture, and a line says where a new day starts. Pure, so it is tested without a
 * browser.
 */

/** Messages from one sender within this long of each other read as one turn. */
export const GROUP_GAP_MS = 5 * 60_000;

export interface Groupable {
  /** Who wrote it: a participant id where there is one, else kind and name. */
  author: string;
  /** When it was written (ms), or null for a message not confirmed yet. */
  at: number | null;
  /** Never part of a turn: cards, notices and the like stand alone. */
  alone?: boolean;
}

export interface Placement {
  /** The first message of its sender's turn: shows who is writing. */
  first: boolean;
  /** The last message of the turn. */
  last: boolean;
  /** The day this message starts, as `YYYY-MM-DD` in the visitor's time zone; null otherwise. */
  day: string | null;
}

/** The calendar day of a moment in the visitor's own time zone. */
export function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const together = (a: Groupable, b: Groupable) =>
  !a.alone &&
  !b.alone &&
  a.author === b.author &&
  // A message still being sent belongs with the one before it.
  (a.at === null ||
    b.at === null ||
    (Math.abs(b.at - a.at) < GROUP_GAP_MS && dayKey(a.at) === dayKey(b.at)));

/** Where each message sits: first or last of its turn, and whether a day starts with it. */
export function place(items: readonly Groupable[]): Placement[] {
  let previousDay: string | null = null;
  return items.map((item, index) => {
    const before = index > 0 ? items[index - 1] : undefined;
    const after = items[index + 1];
    const key = item.at === null ? null : dayKey(item.at);
    const day = key !== null && key !== previousDay ? key : null;
    if (key !== null) previousDay = key;
    return {
      first: !before || !together(before, item) || day !== null,
      last: !after || !together(item, after),
      day,
    };
  });
}

/** "Today", "Yesterday" or the date, for the line where a day starts. */
export function dayLabel(
  day: string,
  now: Date,
  locale: string,
  words: { today: string; yesterday: string },
): string {
  if (day === dayKey(now.getTime())) return words.today;
  if (day === dayKey(now.getTime() - 86_400_000)) return words.yesterday;
  const [year, month, date] = day.split('-').map(Number);
  const moment = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
  const sameYear = moment.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(moment);
}
