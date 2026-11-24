import type { WidgetConfig } from '@hamnivo/contracts';

/**
 * Who can answer right now (W11), read only from the brand's configuration: whether someone on
 * the team is online, and the business hours. The chat says it in plain words, never guesses.
 */

type Availability = WidgetConfig['availability'];

export type AvailabilityStatus =
  /** Someone on the team is online: a person can join. */
  | { kind: 'online' }
  /** Inside business hours, but nobody online: a person answers as soon as they can. */
  | { kind: 'busy' }
  /** Outside business hours, with the time people are back. */
  | { kind: 'away'; until: string }
  /** Nobody online and no hours to say when: the message waits. */
  | { kind: 'nobody' };

export function availabilityOf(availability: Availability): AvailabilityStatus {
  if (availability.staffOnline) return { kind: 'online' };
  if (availability.open) return { kind: 'busy' };
  const next = availability.nextOpenAt;
  if (availability.hoursSet && next && !Number.isNaN(Date.parse(next))) {
    return { kind: 'away', until: next };
  }
  return { kind: 'nobody' };
}

/**
 * When people are back, in the brand's time zone and named so ("Mon, 9:00 AM GST"). A time zone
 * the browser does not know falls back to the visitor's own, still named.
 */
export function backAt(at: string, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(at));
  }
}

/**
 * Whether the contact form replaces "a person will answer" (W11): when the brand turned it on,
 * and it is outside business hours (unless the brand only wants it when nobody is online), or
 * nobody is online (unless the brand only wants it outside business hours).
 */
export function offlineFormApplies(config: Pick<WidgetConfig, 'availability' | 'forms'>): boolean {
  const form = config.forms?.offline;
  if (!form?.enabled || form.fields.length === 0) return false;
  const { availability } = config;
  const closed = form.when !== 'nobody_online' && availability.hoursSet && !availability.open;
  const nobodyOnline = form.when !== 'closed' && !availability.staffOnline;
  return closed || nobodyOnline;
}

/**
 * Whether the standing "Talk to a person" button shows, by the brand's choice (W11). With
 * `after_ai` customers try the AI first: the button comes once the AI has answered a few times in
 * the conversation. A gateway from before the choice sends none, which means the button always
 * shows, as it did. Customers can still ask for a person in their own words at any time.
 */
export function showPersonButton(
  handoff: WidgetConfig['handoff'],
  messages: readonly { sender: { kind: string } }[],
): boolean {
  const mode = handoff?.personButton ?? 'always';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const answers = messages.filter((message) => message.sender.kind === 'ai_agent').length;
  return answers >= (handoff?.afterAnswers ?? 0);
}
