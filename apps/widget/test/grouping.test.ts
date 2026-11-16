import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, GROUP_GAP_MS, place } from '../src/components/thread/grouping.js';

const noon = new Date(2026, 10, 4, 12, 0, 0).getTime();
const minutes = (count: number) => noon + count * 60_000;

describe('how messages sit together', () => {
  it('shows who is writing once per turn', () => {
    const spots = place([
      { author: 'ai', at: minutes(0) },
      { author: 'ai', at: minutes(1) },
      { author: 'me', at: minutes(2) },
      { author: 'ai', at: minutes(3) },
    ]);
    expect(spots.map((s) => s.first)).toEqual([true, false, true, true]);
    expect(spots.map((s) => s.last)).toEqual([false, true, true, true]);
  });

  it('starts a new turn after a pause, and for cards and notices', () => {
    const spots = place([
      { author: 'ai', at: minutes(0) },
      { author: 'ai', at: minutes(0) + GROUP_GAP_MS },
      { author: 'ai', at: minutes(6), alone: true },
      { author: 'ai', at: minutes(6) },
    ]);
    expect(spots.map((s) => s.first)).toEqual([true, true, true, true]);
  });

  it('says once where a day starts, and a new day starts a new turn', () => {
    const lateEvening = new Date(2026, 10, 4, 23, 59, 0).getTime();
    const spots = place([
      { author: 'ai', at: lateEvening },
      { author: 'ai', at: lateEvening + 2 * 60_000 },
      { author: 'ai', at: lateEvening + 3 * 60_000 },
    ]);
    expect(spots.map((s) => s.day)).toEqual(['2026-11-04', '2026-11-05', null]);
    expect(spots.map((s) => s.first)).toEqual([true, true, false]);
  });

  it('keeps a message still being sent with the one before it', () => {
    const spots = place([
      { author: 'me', at: minutes(0) },
      { author: 'me', at: null },
    ]);
    expect(spots[1]).toEqual({ first: false, last: true, day: null });
  });

  it('names today and yesterday in words, and other days by date', () => {
    const now = new Date(2026, 10, 4, 9, 0, 0);
    const words = { today: 'Today', yesterday: 'Yesterday' };
    expect(dayLabel(dayKey(now.getTime()), now, 'en', words)).toBe('Today');
    expect(dayLabel('2026-11-03', now, 'en', words)).toBe('Yesterday');
    expect(dayLabel('2026-10-28', now, 'en', words)).toBe('Wed, Oct 28');
    expect(dayLabel('2025-12-31', now, 'en', words)).toContain('2025');
  });
});
