import { describe, expect, it } from 'vitest';
import {
  effectiveRetention,
  planRetention,
  RETENTION_GRACE_DAYS,
  type RetentionState,
  retentionCutoff,
} from '../src/retention.js';

const now = new Date('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
const off: RetentionState = { conversationDays: null, pendingDays: null, pendingFrom: null };
const graceEnds = new Date(now.getTime() + RETENTION_GRACE_DAYS * DAY);

describe('retention (A10)', () => {
  it('waits out the grace before turning on or shortening', () => {
    expect(planRetention(off, 365, now)).toEqual({
      conversationDays: null,
      pendingDays: 365,
      pendingFrom: graceEnds,
    });
    expect(planRetention({ ...off, conversationDays: 730 }, 365, now)).toEqual({
      conversationDays: 730,
      pendingDays: 365,
      pendingFrom: graceEnds,
    });
  });

  it('keeps longer, or forever, at once and cancels a waiting change', () => {
    const waiting = { conversationDays: 730, pendingDays: 90, pendingFrom: graceEnds };
    expect(planRetention(waiting, 1825, now)).toEqual({
      conversationDays: 1825,
      pendingDays: null,
      pendingFrom: null,
    });
    expect(planRetention(waiting, null, now)).toEqual(off);
  });

  it('undoes a waiting change when the period in force is saved again', () => {
    const waiting = { conversationDays: 730, pendingDays: 90, pendingFrom: graceEnds };
    expect(planRetention(waiting, 730, now)).toEqual({
      conversationDays: 730,
      pendingDays: null,
      pendingFrom: null,
    });
    expect(planRetention({ ...off, pendingDays: 365, pendingFrom: graceEnds }, null, now)).toEqual(
      off,
    );
  });

  it('does not restart the grace when the waiting change is saved again', () => {
    const waiting = { conversationDays: null, pendingDays: 365, pendingFrom: graceEnds };
    const later = new Date(now.getTime() + 3 * DAY);
    expect(planRetention(waiting, 365, later)).toEqual(waiting);
    // A different, shorter period starts its own grace.
    expect(planRetention(waiting, 180, later).pendingFrom).toEqual(
      new Date(later.getTime() + RETENTION_GRACE_DAYS * DAY),
    );
  });

  it('applies a waiting change once its grace has ended', () => {
    const waiting = { conversationDays: null, pendingDays: 365, pendingFrom: graceEnds };
    expect(effectiveRetention(waiting, now)).toEqual(waiting);
    expect(effectiveRetention(waiting, graceEnds)).toEqual({
      conversationDays: 365,
      pendingDays: null,
      pendingFrom: null,
    });
    // Saving after the grace compares with the period now in force.
    expect(planRetention(waiting, 365, graceEnds)).toEqual({
      conversationDays: 365,
      pendingDays: null,
      pendingFrom: null,
    });
  });

  it('counts the cutoff back from now', () => {
    expect(retentionCutoff(90, now)).toEqual(new Date(now.getTime() - 90 * DAY));
  });
});
