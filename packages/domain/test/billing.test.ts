import { describe, expect, it } from 'vitest';
import {
  aiAllowance,
  canMoveInvoice,
  draftInvoice,
  InvalidPeriodError,
  InvalidPricingError,
  type PlanLimits,
  type PlanPricing,
  parseLimits,
  periodFromKey,
  periodOf,
  previousPeriod,
  secondsUntilEnd,
  thresholdsReached,
  UNLIMITED,
  usageStatus,
  withinLimit,
} from '../src/billing/index.js';

const limits = (overrides: Partial<PlanLimits>): PlanLimits => ({ ...UNLIMITED, ...overrides });

describe('billing periods', () => {
  it('are UTC calendar months', () => {
    const period = periodOf(new Date('2026-09-27T23:59:59.999Z'));
    expect(period).toEqual({
      key: '2026-09',
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-10-01T00:00:00Z'),
    });
    expect(periodOf(new Date('2026-10-01T00:00:00Z')).key).toBe('2026-10');
    expect(periodFromKey('2026-12').end).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(previousPeriod(periodFromKey('2026-01')).key).toBe('2025-12');
  });

  it('refuses a malformed period name', () => {
    for (const bad of ['2026-13', '2026-9', 'september', '2026-00']) {
      expect(() => periodFromKey(bad)).toThrow(InvalidPeriodError);
    }
  });

  it('counts the seconds left, never less than one', () => {
    const period = periodFromKey('2026-09');
    expect(secondsUntilEnd(period, new Date('2026-09-30T23:59:00Z'))).toBe(60);
    expect(secondsUntilEnd(period, new Date('2026-10-02T00:00:00Z'))).toBe(1);
  });
});

describe('limits', () => {
  it('reads stored limits, treating anything invalid as unlimited rather than zero', () => {
    expect(
      parseLimits({ conversations: 1000, seats: -2, aiTokens: 1.5, webhookEndpoints: 0 }),
    ).toEqual(limits({ conversations: 1000, webhookEndpoints: 0 }));
    expect(parseLimits(null)).toEqual(UNLIMITED);
  });

  it('allows up to the limit and not one more', () => {
    expect(withinLimit(999, 1000)).toBe(true);
    expect(withinLimit(1000, 1000)).toBe(false);
    expect(withinLimit(4096, 5000, 904)).toBe(true);
    expect(withinLimit(4096, 5000, 905)).toBe(false);
    expect(withinLimit(10 ** 9, null)).toBe(true);
  });

  it('describes usage against a limit', () => {
    expect(usageStatus(240, 1000)).toMatchObject({ remaining: 760, ratio: 0.24, state: 'ok' });
    expect(usageStatus(800, 1000).state).toBe('warning');
    expect(usageStatus(1000, 1000)).toMatchObject({ remaining: 0, state: 'reached' });
    expect(usageStatus(5, null)).toMatchObject({ state: 'unlimited', remaining: null });
    expect(usageStatus(0, 0).state).toBe('reached');
  });

  it('finds the alert thresholds reached', () => {
    expect(thresholdsReached(79, 100)).toEqual([]);
    expect(thresholdsReached(80, 100)).toEqual([80]);
    expect(thresholdsReached(100, 100)).toEqual([80, 100]);
    expect(thresholdsReached(50, 100, [100, 50, 0, 150])).toEqual([50]);
    expect(thresholdsReached(50, null)).toEqual([]);
  });

  it('stops AI replies at the plan limits and at the workspace budget', () => {
    const base = { budgetTokens: null, repliesUsed: 0, tokensUsed: 0 };
    expect(aiAllowance({ ...base, limits: UNLIMITED })).toEqual({ allowed: true });
    expect(aiAllowance({ ...base, limits: limits({ aiReplies: 10 }), repliesUsed: 10 })).toEqual({
      allowed: false,
      reason: 'plan_replies',
      limit: 10,
      used: 10,
    });
    expect(
      aiAllowance({ ...base, limits: limits({ aiReplies: 10 }), repliesUsed: 9 }).allowed,
    ).toBe(true);
    expect(
      aiAllowance({ ...base, limits: limits({ aiTokens: 5000 }), tokensUsed: 5000 }),
    ).toMatchObject({ reason: 'plan_tokens' });
    expect(
      aiAllowance({
        ...base,
        limits: limits({ aiTokens: 5000 }),
        budgetTokens: 2000,
        tokensUsed: 2100,
      }),
    ).toMatchObject({ reason: 'budget_tokens', limit: 2000 });
  });
});

const team: PlanPricing = {
  key: 'team',
  name: 'Team',
  currency: 'AED',
  priceMinor: 10_000n,
  metered: [
    { limit: 'aiTokens', includedUnits: 1_000_000, unitPriceMinor: 20n, perUnits: 1000 },
    { limit: 'conversations', includedUnits: 1000, unitPriceMinor: 50n, perUnits: 1 },
  ],
};

describe('invoices', () => {
  it('charges the plan price and nothing more within the included usage', () => {
    const draft = draftInvoice(
      team,
      { aiTokens: 999_999, conversations: 1000 },
      periodFromKey('2026-09'),
    );
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ kind: 'plan', amountMinor: 10_000n });
    expect(draft.totalMinor).toBe(10_000n);
    expect(draft.currency).toBe('AED');
  });

  it('charges started blocks of metered usage beyond what is included', () => {
    const draft = draftInvoice(
      team,
      { aiTokens: 1_000_001, conversations: 1240 },
      periodFromKey('2026-09'),
    );
    const tokens = draft.lines.find((l) => l.limitKey === 'aiTokens');
    expect(tokens).toMatchObject({ billableUnits: 1, amountMinor: 20n, quantity: 1_000_001 });
    const conversations = draft.lines.find((l) => l.limitKey === 'conversations');
    expect(conversations).toMatchObject({ billableUnits: 240, amountMinor: 12_000n });
    expect(draft.totalMinor).toBe(10_000n + 20n + 12_000n);
    expect(draft.subtotalMinor).toBe(draft.totalMinor);
  });

  it('refuses prices that make no sense', () => {
    const period = periodFromKey('2026-09');
    expect(() => draftInvoice({ ...team, currency: 'XYZ' }, {}, period)).toThrow();
    expect(() => draftInvoice({ ...team, priceMinor: -1n }, {}, period)).toThrow(
      InvalidPricingError,
    );
    expect(() =>
      draftInvoice(
        {
          ...team,
          metered: [{ limit: 'aiTokens', includedUnits: 0, unitPriceMinor: 1n, perUnits: 0 }],
        },
        {},
        period,
      ),
    ).toThrow(InvalidPricingError);
    expect(() =>
      draftInvoice(
        {
          ...team,
          metered: [
            { limit: 'seats' as 'aiTokens', includedUnits: 0, unitPriceMinor: 1n, perUnits: 1 },
          ],
        },
        {},
        period,
      ),
    ).toThrow(InvalidPricingError);
  });

  it('moves draft → issued → paid, voids only unpaid invoices, and never reopens', () => {
    expect(canMoveInvoice('draft', 'issued')).toBe(true);
    expect(canMoveInvoice('issued', 'paid')).toBe(true);
    expect(canMoveInvoice('draft', 'void')).toBe(true);
    expect(canMoveInvoice('issued', 'void')).toBe(true);
    expect(canMoveInvoice('draft', 'paid')).toBe(false);
    expect(canMoveInvoice('paid', 'void')).toBe(false);
    expect(canMoveInvoice('void', 'issued')).toBe(false);
    expect(canMoveInvoice('paid', 'issued')).toBe(false);
  });
});
