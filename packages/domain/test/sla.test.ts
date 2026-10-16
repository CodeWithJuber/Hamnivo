import { describe, expect, it } from 'vitest';
import type { BusinessHours } from '../src/business-hours.js';
import {
  nextSlaClock,
  type SlaClock,
  type SlaFacts,
  type SlaTargets,
  slaOutcomeOf,
  slaView,
} from '../src/sla.js';

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

describe('a reply recorded late (H12)', () => {
  it('ends the clock it answered, even after the customer wrote again', () => {
    const running = run(facts({ lastHumanReplyAt: t('09:00:00') }), t('10:01:00')).clock;
    expect(running).toMatchObject({ kind: 'next_reply', startedAt: t('10:00:00') });
    // A person replied at 10:05; the customer wrote again at 10:06, before that reply was seen.
    const next = run(
      facts({ lastHumanReplyAt: t('10:05:00'), lastCustomerMessageAt: t('10:06:00') }),
      t('10:07:00'),
      running,
    ).clock;
    expect(next).toMatchObject({ kind: 'next_reply', startedAt: t('10:06:00') });
    if (!running) throw new Error('no clock');
    expect(
      slaOutcomeOf({
        clock: running,
        lastHumanReplyAt: t('10:05:00'),
        hours: null,
        now: t('10:07:00'),
      }),
    ).toMatchObject({ outcome: 'met', businessMinutes: 5 });
  });
});

describe('how a reply-time clock ended (H12, O04)', () => {
  const clock = (over: Partial<SlaClock> = {}): SlaClock => ({
    kind: 'first_reply',
    startedAt: t('10:00:00'),
    targetMinutes: 30,
    pausedAt: null,
    pausedMinutes: 0,
    dueAt: t('10:30:00'),
    breachedAt: null,
    ...over,
  });
  const outcome = (
    c: SlaClock,
    reply: Date | null,
    now: Date,
    hours: BusinessHours | null = null,
  ) => slaOutcomeOf({ clock: c, lastHumanReplyAt: reply, hours, now });

  it("is met by a person's reply in time, and missed by one too late", () => {
    expect(outcome(clock(), t('10:20:00'), t('10:20:01'))).toEqual({
      outcome: 'met',
      endedAt: t('10:20:00'),
      businessMinutes: 20,
    });
    expect(outcome(clock(), t('10:30:00'), t('10:30:00')).outcome).toBe('met');
    expect(outcome(clock(), t('10:45:00'), t('10:45:00'))).toEqual({
      outcome: 'missed',
      endedAt: t('10:45:00'),
      businessMinutes: 45,
    });
  });

  it('is missed once it went overdue, even if the target was raised since', () => {
    const late = clock({ targetMinutes: 120, breachedAt: t('10:30:00') });
    expect(outcome(late, t('10:40:00'), t('10:40:00')).outcome).toBe('missed');
  });

  it('leaves the time snoozed out', () => {
    // 50 minutes went by, 25 of them snoozed: 25 working minutes, in time.
    expect(outcome(clock({ pausedMinutes: 25 }), t('10:50:00'), t('10:50:00'))).toMatchObject({
      outcome: 'met',
      businessMinutes: 25,
    });
    // Still snoozed when the person replied: the pause so far counts out too.
    const snoozed = clock({ pausedAt: t('10:10:00'), dueAt: null });
    expect(outcome(snoozed, t('11:00:00'), t('11:00:00'))).toMatchObject({
      outcome: 'met',
      businessMinutes: 10,
    });
  });

  it('counts only working time', () => {
    const hours: BusinessHours = {
      timezone: 'UTC',
      weekly: {
        sun: [],
        mon: [
          { open: '09:00', close: '10:00' },
          { open: '11:00', close: '17:00' },
        ],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closedDates: [],
    };
    // 10:00 to 11:10 is an hour closed and ten working minutes.
    expect(outcome(clock(), t('11:10:00'), t('11:10:00'), hours)).toMatchObject({
      outcome: 'met',
      businessMinutes: 10,
    });
  });

  it('was stopped when it ended without a reply from a person', () => {
    expect(outcome(clock(), null, t('10:40:00'))).toEqual({
      outcome: 'stopped',
      endedAt: t('10:40:00'),
      businessMinutes: 40,
    });
    // A reply from before this clock started does not end it.
    expect(outcome(clock(), t('09:50:00'), t('10:40:00')).outcome).toBe('stopped');
  });
});
