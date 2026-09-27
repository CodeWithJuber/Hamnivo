import { describe, expect, it } from 'vitest';
import { type BusinessHours, isOpen, isValidTimeZone, nextOpening } from '../src/business-hours.js';

const nineToFive = [{ open: '09:00', close: '17:00' }];
const karachi: BusinessHours = {
  timezone: 'Asia/Karachi',
  weekly: {
    sun: [],
    mon: nineToFive,
    tue: nineToFive,
    wed: nineToFive,
    thu: nineToFive,
    // Friday: morning, a break for Jumu'ah, then the afternoon.
    fri: [
      { open: '09:00', close: '12:30' },
      { open: '14:30', close: '17:00' },
    ],
    sat: [{ open: '10:00', close: '14:00' }],
  },
  closedDates: ['2026-10-01'],
};

// Asia/Karachi is UTC+5 all year.
const at = (iso: string) => new Date(iso);

describe('business hours', () => {
  it('knows when people are working, in the business time zone', () => {
    expect(isOpen(karachi, at('2026-09-28T04:00:00Z'))).toBe(true); // Mon 09:00
    expect(isOpen(karachi, at('2026-09-28T03:59:00Z'))).toBe(false); // Mon 08:59
    expect(isOpen(karachi, at('2026-09-28T12:00:00Z'))).toBe(false); // Mon 17:00 (closing)
    expect(isOpen(karachi, at('2026-10-02T08:00:00Z'))).toBe(false); // Fri 13:00 (break)
    expect(isOpen(karachi, at('2026-10-02T10:00:00Z'))).toBe(true); // Fri 15:00
    expect(isOpen(karachi, at('2026-09-27T06:00:00Z'))).toBe(false); // Sunday
    expect(isOpen(karachi, at('2026-10-01T06:00:00Z'))).toBe(false); // closed date (a Thursday)
  });

  it('finds the next opening across breaks, weekends and closed dates', () => {
    expect(nextOpening(karachi, at('2026-10-02T08:00:00Z'))?.toISOString()).toBe(
      '2026-10-02T09:30:00.000Z', // Fri 14:30
    );
    expect(nextOpening(karachi, at('2026-09-26T10:00:00Z'))?.toISOString()).toBe(
      '2026-09-28T04:00:00.000Z', // Sat 15:00 → Mon 09:00
    );
    expect(nextOpening(karachi, at('2026-09-30T13:00:00Z'))?.toISOString()).toBe(
      '2026-10-02T04:00:00.000Z', // Wed 18:00 → skip closed Thu → Fri 09:00
    );
    const never: BusinessHours = {
      ...karachi,
      weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    };
    expect(nextOpening(never, at('2026-09-28T04:00:00Z'))).toBeNull();
  });

  it('follows clock changes', () => {
    const london: BusinessHours = {
      timezone: 'Europe/London',
      weekly: {
        sun: nineToFive,
        mon: nineToFive,
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closedDates: [],
    };
    // Clocks go back on Sunday 25 October 2026: 09:00 is 08:00 UTC before and 09:00 UTC after.
    expect(nextOpening(london, at('2026-10-24T20:00:00Z'))?.toISOString()).toBe(
      '2026-10-25T09:00:00.000Z',
    );
    expect(isOpen(london, at('2026-10-25T08:30:00Z'))).toBe(false);
    expect(isOpen(london, at('2026-10-25T09:30:00Z'))).toBe(true);
  });

  it('checks time zone names', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
