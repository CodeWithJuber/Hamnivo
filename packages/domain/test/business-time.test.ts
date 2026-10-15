import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  type BusinessHours,
  businessMinutesBetween,
} from '../src/business-hours.js';

const weekdays = (open: string, close: string) => [{ open, close }];
const office = (timezone: string, closedDates: string[] = []): BusinessHours => ({
  timezone,
  weekly: {
    sun: [],
    mon: weekdays('09:00', '17:00'),
    tue: weekdays('09:00', '17:00'),
    wed: weekdays('09:00', '17:00'),
    thu: weekdays('09:00', '17:00'),
    fri: [
      { open: '09:00', close: '12:30' },
      { open: '14:00', close: '17:00' },
    ],
    sat: [],
  },
  closedDates,
});
const utc = office('UTC');

describe('working minutes (H12)', () => {
  it('counts every minute when there is no schedule', () => {
    const from = new Date('2026-10-12T10:00:00Z');
    expect(businessMinutesBetween(null, from, new Date('2026-10-12T11:30:00Z'))).toBe(90);
    expect(addBusinessMinutes(null, from, 45)).toEqual(new Date('2026-10-12T10:45:00Z'));
    expect(businessMinutesBetween(null, from, from)).toBe(0);
  });

  it('counts only the open hours, across nights, weekends and breaks', () => {
    // Monday 16:30 to Tuesday 09:30: 30 minutes on Monday, 30 on Tuesday.
    expect(
      businessMinutesBetween(
        utc,
        new Date('2026-10-12T16:30:00Z'),
        new Date('2026-10-13T09:30:00Z'),
      ),
    ).toBe(60);
    // Friday 12:00 to Monday 10:00: 30 before the break, 180 after it, 60 on Monday.
    expect(
      businessMinutesBetween(
        utc,
        new Date('2026-10-16T12:00:00Z'),
        new Date('2026-10-19T10:00:00Z'),
      ),
    ).toBe(270);
  });

  it('moves a deadline past closed time', () => {
    // 60 minutes from Monday 16:30: 30 today, the rest at 09:00 on Tuesday.
    expect(addBusinessMinutes(utc, new Date('2026-10-12T16:30:00Z'), 60)).toEqual(
      new Date('2026-10-13T09:30:00Z'),
    );
    // Started on a Sunday: the clock waits for Monday morning.
    expect(addBusinessMinutes(utc, new Date('2026-10-11T08:00:00Z'), 15)).toEqual(
      new Date('2026-10-12T09:15:00Z'),
    );
    // Over the Friday break.
    expect(addBusinessMinutes(utc, new Date('2026-10-16T12:00:00Z'), 60)).toEqual(
      new Date('2026-10-16T14:30:00Z'),
    );
  });

  it('skips closed dates', () => {
    const holiday = office('UTC', ['2026-10-13']);
    expect(addBusinessMinutes(holiday, new Date('2026-10-12T16:30:00Z'), 60)).toEqual(
      new Date('2026-10-14T09:30:00Z'),
    );
  });

  it('keeps local working hours across a clock change', () => {
    // London leaves summer time on Sunday 25 October 2026: 09:00 is 08:00Z before, 09:00Z after.
    const london = office('Europe/London');
    expect(addBusinessMinutes(london, new Date('2026-10-23T15:30:00Z'), 60)).toEqual(
      new Date('2026-10-26T09:30:00Z'),
    );
    // New York: 30 minutes on Friday after 16:30 local, 30 on Monday from 09:00 local.
    const newYork = office('America/New_York');
    expect(
      businessMinutesBetween(
        newYork,
        new Date('2026-10-30T20:30:00Z'),
        new Date('2026-11-02T14:30:00Z'),
      ),
    ).toBe(60);
  });

  it('ends a day at 24:00 and joins spans that meet', () => {
    const late: BusinessHours = {
      timezone: 'UTC',
      weekly: {
        sun: [],
        mon: [
          { open: '20:00', close: '24:00' },
          { open: '18:00', close: '21:00' },
        ],
        tue: [{ open: '00:00', close: '02:00' }],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closedDates: [],
    };
    expect(
      businessMinutesBetween(
        late,
        new Date('2026-10-12T17:00:00Z'),
        new Date('2026-10-13T03:00:00Z'),
      ),
    ).toBe(8 * 60);
    expect(addBusinessMinutes(late, new Date('2026-10-12T23:30:00Z'), 60)).toEqual(
      new Date('2026-10-13T00:30:00Z'),
    );
  });

  it('gives no deadline for a schedule that never opens', () => {
    const closed: BusinessHours = {
      timezone: 'UTC',
      weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      closedDates: [],
    };
    expect(addBusinessMinutes(closed, new Date('2026-10-12T10:00:00Z'), 5)).toBeNull();
    expect(
      businessMinutesBetween(
        closed,
        new Date('2026-10-12T10:00:00Z'),
        new Date('2026-10-20T10:00:00Z'),
      ),
    ).toBe(0);
  });
});
