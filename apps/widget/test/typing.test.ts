import { describe, expect, it } from 'vitest';
import {
  afterIdle,
  afterPersonTyping,
  afterTyping,
  NOBODY,
  PERSON_TYPING_MS,
  QUIET,
  REPORT_REPEAT_MS,
} from '../src/useTyping.js';

describe('telling staff the visitor is typing', () => {
  it('reports the first keystroke, then every few seconds while typing continues', () => {
    const first = afterTyping(QUIET, 'H', 1000);
    expect(first).toEqual({ state: { typing: true, sentAt: 1000 }, send: true });
    // More keystrokes soon after change nothing.
    const soon = afterTyping(first.state, 'He', 2000);
    expect(soon).toEqual({ state: first.state, send: null });
    // After the repeat time, one more report keeps staff's line from running out.
    const later = afterTyping(soon.state, 'Hello', 1000 + REPORT_REPEAT_MS);
    expect(later).toEqual({ state: { typing: true, sentAt: 1000 + REPORT_REPEAT_MS }, send: true });
  });

  it('says "stopped" once when the box is emptied, and nothing when nothing was reported', () => {
    const typing = afterTyping(QUIET, 'Hi', 0).state;
    const cleared = afterTyping(typing, '', 500);
    expect(cleared).toEqual({ state: { typing: false, sentAt: 0 }, send: false });
    // Emptied again, or never typed: nothing to say.
    expect(afterTyping(cleared.state, '', 600)).toEqual({ state: cleared.state, send: null });
    expect(afterTyping(QUIET, '   ', 600)).toEqual({ state: QUIET, send: null });
  });

  it('does not count spaces as typing', () => {
    expect(afterTyping(QUIET, '   ', 0).send).toBeNull();
    expect(afterTyping(QUIET, ' \n ', 0).send).toBeNull();
  });

  it('says "stopped" once after a quiet spell', () => {
    const typing = afterTyping(QUIET, 'Hi', 0).state;
    const idle = afterIdle(typing);
    expect(idle).toEqual({ state: { typing: false, sentAt: 0 }, send: false });
    expect(afterIdle(idle.state)).toEqual({ state: idle.state, send: null });
    // Typing again afterwards is a new start, reported at once.
    expect(afterTyping(idle.state, 'Hi again', 10).send).toBe(true);
  });
});

describe('a person typing a reply', () => {
  it('shows their name for a few seconds, which a new report extends', () => {
    expect(afterPersonTyping({ typing: true, displayName: 'Amina Agent' }, 1000)).toEqual({
      name: 'Amina Agent',
      until: 1000 + PERSON_TYPING_MS,
    });
  });

  it('ends at once on "stopped", and on anything that is not a typing report', () => {
    expect(afterPersonTyping({ typing: false, displayName: 'Amina Agent' }, 1000)).toBe(NOBODY);
    expect(afterPersonTyping(undefined, 1000)).toBe(NOBODY);
    expect(afterPersonTyping({ displayName: 'Amina' }, 1000)).toBe(NOBODY);
  });

  it('shows "a person" when there is no name to show', () => {
    expect(afterPersonTyping({ typing: true }, 0)).toEqual({ name: '', until: PERSON_TYPING_MS });
    expect(afterPersonTyping({ typing: true, displayName: '  ' }, 0).name).toBe('');
    expect(afterPersonTyping({ typing: true, displayName: 7 }, 0).name).toBe('');
  });
});
