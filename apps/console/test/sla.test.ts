import { describe, expect, it } from 'vitest';
import {
  bodyOfTargets,
  draftOfTarget,
  draftOfTargets,
  type InboxSla,
  minutesOfTarget,
  problemsOfTargets,
  readSla,
  type SlaTargets,
} from '../src/lib/sla';

const NOW = Date.parse('2026-10-15T10:00:00.000Z');
const clock = (patch: Partial<InboxSla> = {}): InboxSla => ({
  kind: 'first_reply',
  state: 'running',
  dueAt: new Date(NOW + 30 * 60_000).toISOString(),
  businessMinutesLeft: 30,
  breached: false,
  targetMinutes: 60,
  ...patch,
});

describe('how a reply-time clock reads (H12)', () => {
  it('counts down to the deadline, nearly due in its last fifth', () => {
    expect(readSla(clock(), NOW)).toEqual({ kind: 'dueIn', minutes: 30 });
    const soon = clock({ dueAt: new Date(NOW + 11 * 60_000).toISOString() });
    expect(readSla(soon, NOW)).toEqual({ kind: 'dueSoon', minutes: 11 });
    // A short target is nearly due in its last five minutes.
    const short = clock({ targetMinutes: 10, dueAt: new Date(NOW + 5 * 60_000).toISOString() });
    expect(readSla(short, NOW)).toEqual({ kind: 'dueSoon', minutes: 5 });
    expect(readSla(clock({ dueAt: new Date(NOW).toISOString() }), NOW)).toEqual({
      kind: 'dueNow',
    });
  });

  it('is overdue once the deadline passed, or when the gateway says so', () => {
    const past = clock({ dueAt: new Date(NOW - 12 * 60_000).toISOString() });
    expect(readSla(past, NOW)).toEqual({ kind: 'overdue', minutes: 12 });
    expect(readSla(clock({ breached: true }), NOW)).toEqual({ kind: 'overdue', minutes: 0 });
  });

  it('says when it is paused or waits for opening hours', () => {
    expect(readSla(clock({ state: 'paused', dueAt: null }), NOW)).toEqual({ kind: 'paused' });
    expect(readSla(clock({ state: 'outside_hours', dueAt: null }), NOW)).toEqual({
      kind: 'outsideHours',
    });
  });
});

describe('the reply-time targets form', () => {
  const targets: SlaTargets = {
    urgent: { firstReplyMinutes: 5, nextReplyMinutes: 10 },
    high: { firstReplyMinutes: 60, nextReplyMinutes: 90 },
    medium: { firstReplyMinutes: 240, nextReplyMinutes: null },
    low: { firstReplyMinutes: null, nextReplyMinutes: null },
  };

  it('shows whole hours in hours and everything else in minutes', () => {
    expect(draftOfTarget(60)).toEqual({ amount: '1', unit: 'hours' });
    expect(draftOfTarget(90)).toEqual({ amount: '90', unit: 'minutes' });
    expect(draftOfTarget(null)).toEqual({ amount: '', unit: 'minutes' });
    expect(bodyOfTargets(draftOfTargets(targets))).toEqual(targets);
  });

  it('accepts whole numbers from one minute to seven days, or nothing', () => {
    expect(minutesOfTarget({ amount: ' 2 ', unit: 'hours' })).toBe(120);
    expect(minutesOfTarget({ amount: '', unit: 'hours' })).toBeNull();
    expect(minutesOfTarget({ amount: '168', unit: 'hours' })).toBe(10_080);
    for (const amount of ['0', '169', '1.5', '-3', 'ten']) {
      expect(minutesOfTarget({ amount, unit: amount === '169' ? 'hours' : 'minutes' })).toBe(
        undefined,
      );
    }
    const draft = draftOfTargets(targets);
    draft.high.nextReplyMinutes = { amount: '0', unit: 'minutes' };
    draft.low.firstReplyMinutes = { amount: '200', unit: 'hours' };
    expect(problemsOfTargets(draft)).toEqual([
      { priority: 'high', column: 'nextReplyMinutes' },
      { priority: 'low', column: 'firstReplyMinutes' },
    ]);
  });
});
