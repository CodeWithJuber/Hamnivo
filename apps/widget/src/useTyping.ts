import { useEffect, useRef, useState } from 'react';
import type { ChatEvent } from './useChat.js';

/** While the visitor keeps typing, the gateway is told this often. */
export const REPORT_REPEAT_MS = 3000;
/** Without a keystroke for this long, the visitor has stopped typing. */
export const REPORT_IDLE_MS = 5000;
/** A person's "typing" lasts this long unless it is repeated (the console repeats it). */
export const PERSON_TYPING_MS = 8000;

/** What the report of the visitor's own typing remembers. */
export interface ReportState {
  typing: boolean;
  /** When "typing" was last sent (ms). */
  sentAt: number;
}

export const QUIET: ReportState = { typing: false, sentAt: 0 };

/**
 * What to tell staff now that the composer holds `text`: "typing" on the first keystroke and then
 * every few seconds, "stopped" when the box is emptied (sent or cleared), and nothing in between.
 */
export function afterTyping(
  state: ReportState,
  text: string,
  now: number,
): { state: ReportState; send: boolean | null } {
  if (text.trim() === '') return afterIdle(state);
  if (!state.typing || now - state.sentAt >= REPORT_REPEAT_MS) {
    return { state: { typing: true, sentAt: now }, send: true };
  }
  return { state, send: null };
}

/** The visitor stopped typing without sending: say so once. */
export function afterIdle(state: ReportState): { state: ReportState; send: boolean | null } {
  return state.typing
    ? { state: { typing: false, sentAt: state.sentAt }, send: false }
    : { state, send: null };
}

/**
 * Tells staff when the visitor is typing in this conversation. It is a courtesy: a report that
 * fails is dropped, and nothing is sent while there is no conversation yet or the visitor types
 * nothing. Staff see "stopped" when the box is emptied or after a few quiet seconds.
 */
export function useTypingReports(
  report: ((typing: boolean) => Promise<unknown>) | null,
  text: string,
): void {
  const state = useRef(QUIET);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = useRef(report);
  send.current = report;

  const apply = (next: { state: ReportState; send: boolean | null }) => {
    state.current = next.state;
    if (next.send !== null) void send.current?.(next.send)?.catch(() => undefined);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the typed text changes
  useEffect(() => {
    if (!send.current) return;
    clearTimeout(idle.current);
    apply(afterTyping(state.current, text, Date.now()));
    if (state.current.typing) {
      idle.current = setTimeout(() => apply(afterIdle(state.current)), REPORT_IDLE_MS);
    }
  }, [text]);

  // Leaving the chat says the visitor stopped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the chat closes
  useEffect(
    () => () => {
      clearTimeout(idle.current);
      apply(afterIdle(state.current));
    },
    [],
  );
}

/** Who is typing a reply, or null. A "stopped" or a quiet spell ends it. */
export interface PersonTyping {
  name: string | null;
  /** When it ends if it is not repeated (ms), 0 when nobody is typing. */
  until: number;
}

export const NOBODY: PersonTyping = { name: null, until: 0 };

/** The state after a `typing` event from the conversation. */
export function afterPersonTyping(
  data: Record<string, unknown> | undefined,
  now: number,
): PersonTyping {
  if (data?.typing !== true) return NOBODY;
  const name =
    typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName : '';
  return { name, until: now + PERSON_TYPING_MS };
}

/**
 * The name of the person typing a reply to this visitor (an empty string when the person has no
 * name to show), or null when nobody is. `subscribe` is the chat's stream of live events.
 */
export function useStaffTyping(
  subscribe: (listener: (event: ChatEvent) => void) => () => void,
): string | null {
  const [typing, setTyping] = useState<PersonTyping>(NOBODY);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'typing') setTyping(afterPersonTyping(event.data, Date.now()));
        // A message from the team ends the typing line even if "stopped" was missed.
        else if (event.type === 'message.created') setTyping(NOBODY);
      }),
    [subscribe],
  );
  useEffect(() => {
    if (typing.until === 0) return;
    const timer = setTimeout(() => setTyping(NOBODY), Math.max(0, typing.until - Date.now()));
    return () => clearTimeout(timer);
  }, [typing]);
  return typing.until > 0 ? typing.name : null;
}
