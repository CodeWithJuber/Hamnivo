import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyRate,
  CURRENCY_CODES,
  CurrencyMismatchError,
  compare,
  currencyOf,
  fromMajor,
  InvalidAmountError,
  isCurrencyCode,
  minorDigits,
  money,
  multiply,
  serializeMoney,
  subtract,
  sum,
  toMajorString,
  toMinor,
  UnknownCurrencyError,
} from '../../src/commerce/index.js';

describe('ISO 4217 currencies', () => {
  it('knows the minor unit of each code, including zero, three and four digits', () => {
    expect(minorDigits('AED')).toBe(2);
    expect(minorDigits('PKR')).toBe(2);
    expect(minorDigits('INR')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KRW')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
    expect(minorDigits('BHD')).toBe(3);
    // ISO says two digits where display data (CLDR) shows none; amounts follow ISO.
    expect(minorDigits('HUF')).toBe(2);
    expect(minorDigits('IDR')).toBe(2);
  });

  it('refuses unknown, withdrawn and non-currency codes', () => {
    for (const code of ['XYZ', 'HRK', 'SLL', 'ZWL', 'XAU', 'XTS', 'CLF', 'aed', '']) {
      expect(isCurrencyCode(code)).toBe(false);
      expect(() => minorDigits(code)).toThrow(UnknownCurrencyError);
    }
    expect(currencyOf(' aed ')).toBe('AED');
    expect(() => currencyOf('dirham')).toThrow(UnknownCurrencyError);
  });

  it('lists only codes that Intl can format', () => {
    const intl = new Set(Intl.supportedValuesOf('currency'));
    expect(CURRENCY_CODES.length).toBeGreaterThan(140);
    expect(CURRENCY_CODES.filter((code) => !intl.has(code))).toEqual([]);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });
});

describe('money arithmetic', () => {
  it('keeps amounts as integer minor units and refuses floats', () => {
    expect(toMinor('14900')).toBe(14_900n);
    expect(toMinor(-5)).toBe(-5n);
    expect(() => toMinor(1.5)).toThrow(InvalidAmountError);
    expect(() => toMinor('1.5')).toThrow(InvalidAmountError);
    expect(() => toMinor('01')).toThrow(InvalidAmountError);
    expect(() => toMinor(2 ** 53)).toThrow(InvalidAmountError);
    expect(() => money(100, 'ABC')).toThrow(UnknownCurrencyError);
  });

  it('adds, subtracts, multiplies and sums exactly, beyond 2^53', () => {
    const big = money(9_007_199_254_740_993n, 'AED');
    expect(add(big, money(2, 'AED')).amountMinor).toBe(9_007_199_254_740_995n);
    expect(subtract(money(6000, 'AED'), money(1500, 'AED')).amountMinor).toBe(4500n);
    expect(multiply(money(3500, 'AED'), 3).amountMinor).toBe(10_500n);
    expect(sum([money(3500, 'AED'), money(1500, 'AED'), money(1000, 'AED')], 'AED')).toEqual(
      money(6000, 'AED'),
    );
    expect(sum([], 'AED')).toEqual(money(0, 'AED'));
    expect(compare(money(1, 'AED'), money(2, 'AED'))).toBe(-1);
    expect(compare(money(2, 'AED'), money(2, 'AED'))).toBe(0);
    expect(serializeMoney(big)).toEqual({ amountMinor: '9007199254740993', currency: 'AED' });
  });

  it('never mixes currencies', () => {
    expect(() => add(money(1, 'AED'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => sum([money(1, 'AED'), money(1, 'USD')], 'AED')).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1, 'AED'), money(1, 'PKR'))).toThrow(CurrencyMismatchError);
  });

  it('converts to and from major units with every minor digit', () => {
    expect(toMajorString(money(6000, 'AED'))).toBe('60.00');
    expect(toMajorString(money(-1505, 'AED'))).toBe('-15.05');
    expect(toMajorString(money(1500, 'JPY'))).toBe('1500');
    expect(toMajorString(money(1500, 'KWD'))).toBe('1.500');
    expect(toMajorString(money('12345678901234567899', 'AED'))).toBe('123456789012345678.99');
    expect(fromMajor('35', 'AED')).toEqual(money(3500, 'AED'));
    expect(fromMajor('35.5', 'AED')).toEqual(money(3550, 'AED'));
    expect(fromMajor('0.001', 'KWD')).toEqual(money(1, 'KWD'));
    expect(fromMajor('123456789012345678.99', 'AED').amountMinor).toBe(12_345_678_901_234_567_899n);
  });

  it('refuses digits the currency does not have unless a rounding rule is given', () => {
    expect(() => fromMajor('35.001', 'AED')).toThrow(InvalidAmountError);
    expect(() => fromMajor('1.5', 'JPY')).toThrow(InvalidAmountError);
    expect(() => fromMajor('1e3', 'AED')).toThrow(InvalidAmountError);
    expect(() => fromMajor('', 'AED')).toThrow(InvalidAmountError);
    expect(fromMajor('35.005', 'AED', 'half_even')).toEqual(money(3500, 'AED'));
    expect(fromMajor('35.015', 'AED', 'half_even')).toEqual(money(3502, 'AED'));
    expect(fromMajor('35.005', 'AED', 'half_up')).toEqual(money(3501, 'AED'));
    expect(fromMajor('35.009', 'AED', 'down')).toEqual(money(3500, 'AED'));
  });

  it('applies rates with an explicit rounding rule', () => {
    // 5 % of AED 0.50 is 2.5 fils: banker's rounding gives 2, half-up gives 3.
    expect(applyRate(money(50, 'AED'), '0.05').amountMinor).toBe(2n);
    expect(applyRate(money(50, 'AED'), '0.05', 'half_up').amountMinor).toBe(3n);
    expect(applyRate(money(6000, 'AED'), '0.05').amountMinor).toBe(300n);
    expect(applyRate(money(333, 'AED'), '1').amountMinor).toBe(333n);
    expect(() => applyRate(money(1, 'AED'), '-0.1')).toThrow(InvalidAmountError);
  });

  it('allocates without losing or inventing a minor unit', () => {
    expect(allocate(money(100, 'AED'), [1n, 1n, 1n]).map((m) => m.amountMinor)).toEqual([
      34n,
      33n,
      33n,
    ]);
    expect(allocate(money(1500, 'AED'), [3500n, 1500n]).map((m) => m.amountMinor)).toEqual([
      1050n,
      450n,
    ]);
    expect(allocate(money(-100, 'AED'), [1n, 2n]).map((m) => m.amountMinor)).toEqual([-33n, -67n]);
    expect(() => allocate(money(1, 'AED'), [])).toThrow(InvalidAmountError);
    expect(() => allocate(money(1, 'AED'), [0n, 0n])).toThrow(InvalidAmountError);
    expect(() => allocate(money(1, 'AED'), [1n, -1n])).toThrow(InvalidAmountError);
    // Deterministic pseudo-random cases: parts always add up to the total.
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    for (let round = 0; round < 200; round += 1) {
      const total = BigInt(next() % 1_000_000);
      const weights = Array.from({ length: 1 + (next() % 6) }, () => BigInt(1 + (next() % 50)));
      const parts = allocate(money(total, 'PKR'), weights);
      expect(parts.reduce((acc, p) => acc + p.amountMinor, 0n)).toBe(total);
    }
  });
});
