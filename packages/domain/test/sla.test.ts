import { describe, expect, it } from 'vitest';
import type { BusinessHours } from '../src/business-hours.js';
import { nextSlaClock, type SlaFacts, type SlaTargets, slaView } from '../src/sla.js';

const policy: SlaTargets = {
  urgent: { firstReplyMinutes: 5, nextReplyMinutes: 10 },
  high: { firstReplyMinutes: 15, nextReplyMinutes: 30 },
  medium: { firstReplyMinutes: 60, nextReplyMinutes: 120 },
  low: { firstReplyMinutes: null, nextReplyMinutes: null },
};
const t = (iso: string) => new Date(`2026-10-12T${iso}Z`);
const facts = (over: Partial<SlaFacts> = {}): SlaFacts => ({
  ownerMode: 'WAITING_HUMAN',
  status: 'open',
  priority: null,
  lastCustomerMessageAt: t('10:00:00'),
  lastHumanReplyAt: null,
  ownerChangedAt: null,
  createdAt: t('10:00:00'),
  ...over,
});
const run = (f: SlaFacts, now: Date, clock = null as ReturnType<typeof nextSlaClock>['clock']) =>
  nextSlaClock({ clock, facts: f, policy, hours: null, now });

describe('reply-time clock (H12)', () => {
  it('starts a first-reply clock when a customer waits for a person', () => {
    const { clock } = run(facts(), t('10:01:00'));
    expect(clock).toMatchObject({
      kind: 'first_reply',
      startedAt: t('10:00:00'),
      targetMinutes: 60,
      dueAt: t('11:00:00'),
      breachedAt: null,
    });
  });

  it('runs no clock while the AI answers, and starts it at the hand-off', () => {
    expect(run(facts({ ownerMode: 'AI_ACTIVE' }), t('10:05:00')).clock).toBeNull();
    const handed = run(facts({ ownerChangedAt: t('10:20:00') }), t('10:20:00')).clock;
    expect(handed?.startedAt).toEqual(t('10:20:00'));
    expect(handed?.dueAt).toEqual(t('11:20:00'));
  });

  it("forgets a person's earlier reply once the AI has the conversation again", () => {
    const back = run(
      facts({ ownerMode: 'AI_ACTIVE', lastHumanReplyAt: t('09:00:00') }),
      t('10:05:00'),
    );
    expect(back).toEqual({ clock: null, resetHumanReply: true });
  });

  it('stops when a person replies and starts a next-reply clock on the next message', () => {
    expect(run(facts({ lastHumanReplyAt: t('10:10:00') }), t('10:11:00')).clock).toBeNull();
    const next = run(
      facts({ lastHumanReplyAt: t('10:10:00'), lastCustomerMessageAt: t('10:30:00') }),
      t('10:31:00'),
    ).clock;
    expect(next).toMatchObject({
      kind: 'next_reply',
      startedAt: t('10:30:00'),
      dueAt: t('12:30:00'),
    });
  });

  it('keeps its start while the customer keeps writing', () => {
    const first = run(facts(), t('10:01:00')).clock;
    const again = run(facts({ lastCustomerMessageAt: t('10:20:00') }), t('10:21:00'), first).clock;
    expect(again?.startedAt).toEqual(t('10:00:00'));
  });

  it('goes overdue once, and comes back if the priority gives more time', () => {
    const urgent = run(facts({ priority: 'urgent' }), t('10:06:00')).clock;
    expect(urgent).toMatchObject({ dueAt: t('10:05:00'), breachedAt: t('10:06:00') });
    const still = run(facts({ priority: 'urgent' }), t('10:09:00'), urgent).clock;
    expect(still?.breachedAt).toEqual(t('10:06:00'));
    const lowered = run(facts({ priority: 'high' }), t('10:09:00'), still).clock;
    expect(lowered).toMatchObject({ dueAt: t('10:15:00'), breachedAt: null });
  });

  it('has no clock without a target, or when resolved', () => {
    expect(run(facts({ priority: 'low' }), t('10:01:00')).clock).toBeNull();
    expect(
      nextSlaClock({ clock: null, facts: facts(), policy: null, hours: null, now: t('10:01:00') })
        .clock,
    ).toBeNull();
    expect(run(facts({ status: 'resolved' }), t('10:01:00')).clock).toBeNull();
  });

  it('pauses while snoozed and moves the deadline out by the time paused', () => {
    const first = run(facts(), t('10:10:00')).clock;
    const snoozed = run(facts({ status: 'snoozed' }), t('10:30:00'), first).clock;
    expect(snoozed).toMatchObject({ pausedAt: t('10:30:00'), dueAt: null });
    const back = run(facts(), t('11:30:00'), snoozed).clock;
    expect(back).toMatchObject({ pausedAt: null, pausedMinutes: 60, dueAt: t('12:00:00') });
  });

  it('counts only working time and says so', () => {
    const hours: BusinessHours = {
      timezone: 'UTC',
      weekly: {
        sun: [],
        mon: [{ open: '09:00', close: '17:00' }],
        tue: [{ open: '09:00', close: '17:00' }],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closedDates: [],
    };
    const { clock } = nextSlaClock({
      clock: null,
      facts: facts({ lastCustomerMessageAt: t('16:30:00'), createdAt: t('16:30:00') }),
      policy,
      hours,
      now: t('16:31:00'),
    });
    expect(clock?.dueAt).toEqual(new Date('2026-10-13T09:30:00Z'));
    if (!clock) throw new Error('clock');
    expect(slaView(clock, hours, t('16:40:00'))).toMatchObject({
      state: 'running',
      businessMinutesLeft: 50,
      breached: false,
    });
    expect(slaView(clock, hours, t('20:00:00'))).toMatchObject({
      state: 'outside_hours',
      businessMinutesLeft: 30,
    });
    expect(slaView(clock, hours, new Date('2026-10-13T09:40:00Z'))).toMatchObject({
      breached: true,
      businessMinutesLeft: -10,
    });
  });
});
