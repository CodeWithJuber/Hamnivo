import { describe, expect, it } from 'vitest';
import {
  median,
  protectBreakdown,
  protectCount,
  protectedAverage,
  protectedMedian,
  protectedRate,
} from '../src/analytics/index.js';

describe('analytics privacy', () => {
  it('shows zero and counts of at least k, and hides counts from 1 to k-1', () => {
    expect(protectCount(0)).toBe(0);
    expect(protectCount(1)).toBeNull();
    expect(protectCount(4)).toBeNull();
    expect(protectCount(5)).toBe(5);
    expect(protectCount(240)).toBe(240);
    expect(protectCount(9, 10)).toBeNull();
  });

  it('hides small rows of a breakdown, and one more when the total is shown', () => {
    const reasons = [
      { key: 'customer_request', count: 30 },
      { key: 'ai_unavailable', count: 2 },
      { key: 'no_agent', count: 12 },
      { key: 'ai_stopped', count: 0 },
    ];
    const withTotal = protectBreakdown(reasons, { totalShown: true });
    expect(withTotal.map((r) => [r.key, r.suppressed])).toEqual([
      ['customer_request', false],
      ['ai_unavailable', true],
      // Otherwise 44 − 30 − 12 would reveal the 2 above.
      ['no_agent', true],
      ['ai_stopped', false],
    ]);
    const withoutTotal = protectBreakdown(reasons, { totalShown: false });
    expect(withoutTotal.filter((r) => r.suppressed).map((r) => r.key)).toEqual(['ai_unavailable']);
    const two = protectBreakdown(
      [
        { key: 'a', count: 1 },
        { key: 'b', count: 3 },
        { key: 'c', count: 50 },
      ],
      { totalShown: true },
    );
    expect(two.filter((r) => r.suppressed).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('publishes a share only over a large enough denominator', () => {
    expect(protectedRate(1, 4)).toBeNull();
    expect(protectedRate(52, 240)).toBeCloseTo(0.2167, 3);
    expect(protectedRate(0, 5)).toBe(0);
    expect(protectedRate(0, 0)).toBeNull();
  });

  it('computes medians and averages only over k values or more', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(protectedMedian([60, 120, 30, 90])).toBeNull();
    expect(protectedMedian([60, 120, 30, 90, 600])).toBe(90);
    expect(protectedAverage([5, 4, 4])).toBeNull();
    expect(protectedAverage([5, 4, 4, 5, 3])).toBeCloseTo(4.2);
  });
});
