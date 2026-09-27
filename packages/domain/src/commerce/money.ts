import { type CurrencyCode, currencyOf, minorDigits } from './currencies.js';
import { DecimalBase, type DecimalRounding } from './decimal.js';

/**
 * Money is an integer count of a currency's minor unit (bigint), never a float. Sums and products
 * stay in bigint; anything with a fraction (rates, major-unit strings) goes through decimal.js with
 * an explicit rounding rule, so a total is always the exact sum of its parts.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Cannot combine ${left} with ${right}`);
  }
}

export class InvalidAmountError extends Error {
  override name = 'InvalidAmountError';
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** Minor units from a bigint, a safe integer or an integer string ("14900"). */
export function toMinor(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new InvalidAmountError(`Not a safe integer: ${value}`);
    return BigInt(value);
  }
  if (!INTEGER.test(value)) throw new InvalidAmountError(`Not an integer amount: ${value}`);
  return BigInt(value);
}

export function money(amountMinor: bigint | number | string, currency: string): Money {
  return { amountMinor: toMinor(amountMinor), currency: currencyOf(currency) };
}

export const zero = (currency: string): Money => money(0n, currency);

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  same(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

/** Unit price × quantity (quantities are whole numbers). */
export function multiply(unit: Money, quantity: bigint | number): Money {
  const q = typeof quantity === 'bigint' ? quantity : toMinor(quantity);
  return { amountMinor: unit.amountMinor * q, currency: unit.currency };
}

export function sum(items: readonly Money[], currency: string): Money {
  let total = zero(currency);
  for (const item of items) total = add(total, item);
  return total;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export const isNegative = (m: Money) => m.amountMinor < 0n;
export const isZero = (m: Money) => m.amountMinor === 0n;
export const equals = (a: Money, b: Money) =>
  a.currency === b.currency && a.amountMinor === b.amountMinor;

export type Rounding = 'half_even' | 'half_up' | 'down' | 'up';

const ROUNDING: Record<Rounding, DecimalRounding> = {
  half_even: DecimalBase.ROUND_HALF_EVEN,
  half_up: DecimalBase.ROUND_HALF_UP,
  down: DecimalBase.ROUND_DOWN,
  up: DecimalBase.ROUND_UP,
};

// A private constructor so global decimal.js settings elsewhere cannot change our results.
const D = DecimalBase.clone({
  precision: 64,
  rounding: DecimalBase.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 64,
});

/** "35.00" for AED 3500 minor units: exact, with every minor digit. */
export function toMajorString(m: Money): string {
  return new D(m.amountMinor.toString())
    .div(new D(10).pow(minorDigits(m.currency)))
    .toFixed(minorDigits(m.currency));
}

/**
 * A major-unit decimal string ("35", "35.5", "35.50") to money. More digits than the currency has
 * are refused (a price of AED 35.001 does not exist), unless a rounding rule is given.
 */
export function fromMajor(value: string, currency: string, rounding?: Rounding): Money {
  const code = currencyOf(currency);
  const trimmed = value.trim();
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new InvalidAmountError(`Not a decimal amount: ${value}`);
  }
  const scaled = new D(trimmed).mul(new D(10).pow(minorDigits(code)));
  if (!scaled.isInteger()) {
    if (!rounding) {
      throw new InvalidAmountError(`${value} has more digits than ${code} allows`);
    }
    return {
      amountMinor: BigInt(scaled.toDecimalPlaces(0, ROUNDING[rounding]).toFixed(0)),
      currency: code,
    };
  }
  return { amountMinor: BigInt(scaled.toFixed(0)), currency: code };
}

/**
 * Applies a decimal rate ("0.05" for 5 %) and rounds to the minor unit with the given rule.
 * Used for percentage fees or tax rates a merchant declares; the rounding is part of the result.
 */
export function applyRate(m: Money, rate: string, rounding: Rounding = 'half_even'): Money {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(rate)) throw new InvalidAmountError(`Not a rate: ${rate}`);
  const result = new D(m.amountMinor.toString())
    .mul(new D(rate))
    .toDecimalPlaces(0, ROUNDING[rounding]);
  return { amountMinor: BigInt(result.toFixed(0)), currency: m.currency };
}

/**
 * Splits `total` across weights so the parts add up exactly (largest remainder). Used to spread a
 * discount or a partial refund over order lines without losing or inventing a minor unit.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new InvalidAmountError('Nothing to allocate across');
  if (weights.some((w) => w < 0n)) throw new InvalidAmountError('Weights must not be negative');
  const sumOfWeights = weights.reduce((acc, w) => acc + w, 0n);
  if (sumOfWeights === 0n) throw new InvalidAmountError('Weights must not all be zero');
  const sign = total.amountMinor < 0n ? -1n : 1n;
  const absolute = total.amountMinor * sign;
  const shares = weights.map((w) => (absolute * w) / sumOfWeights);
  let remainder = absolute - shares.reduce((acc, s) => acc + s, 0n);
  const order = weights
    .map((w, index) => ({ index, rest: (absolute * w) % sumOfWeights }))
    .sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const { index } of order) {
    if (remainder === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return shares.map((share) => ({ amountMinor: share * sign, currency: total.currency }));
}

/** JSON form used by the API and by hashes: minor units as a string, never a number. */
export function serializeMoney(m: Money): { amountMinor: string; currency: string } {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}
