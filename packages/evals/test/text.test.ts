import { describe, expect, it } from 'vitest';
import { formatRate, normalizeDigits, numbersIn, statesValue, wilson } from '../src/index.js';

describe('numbers in any script', () => {
  it('reads Arabic-Indic, Urdu and Devanagari digits and thousands separators', () => {
    expect(normalizeDigits('١٢٠ درهم')).toBe('120 درهم');
    expect(normalizeDigits('۱۸۰۰ روپے')).toBe('1800 روپے');
    expect(normalizeDigits('४९९ रुपये')).toBe('499 रुपये');
    expect(normalizeDigits('INR 5,000 and ٥٬٠٠٠')).toBe('INR 5000 and 5000');
  });

  it('finds a value only as a whole number', () => {
    expect(statesValue('It costs AED 120.', '120')).toBe(true);
    expect(statesValue('It costs AED 1200.', '120')).toBe(false);
    expect(statesValue('Version 1.10 is out', '10')).toBe(false);
    expect(statesValue('التوصيل يستغرق ٥ أيام', '5')).toBe(true);
    expect(numbersIn('Between ٣ and 5 days, or 1,500 PKR')).toEqual(['3', '5', '1500']);
  });
});

describe('rates with confidence intervals', () => {
  it('gives Wilson intervals that stay honest for small slices', () => {
    expect(wilson(0, 0)).toEqual({ successes: 0, total: 0, rate: null, low: null, high: null });
    expect(wilson(10, 10)).toMatchObject({ rate: 1, low: 0.722, high: 1 });
    expect(wilson(0, 10)).toMatchObject({ rate: 0, low: 0, high: 0.278 });
    expect(wilson(6, 12)).toMatchObject({ rate: 0.5, low: 0.254, high: 0.746 });
    expect(formatRate(wilson(11, 12))).toBe('0.917 (0.646–0.985, 11/12)');
    expect(formatRate(wilson(0, 0))).toBe('n/a');
  });
});
