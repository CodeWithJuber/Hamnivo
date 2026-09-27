import { describe, expect, it } from 'vitest';
import {
  type ApprovableQuote,
  type ApprovalAttempt,
  answerCacheDecision,
  type CommerceCapabilities,
  checkQuoteApproval,
  checkRefundApprover,
  DEFAULT_REFUND_POLICY,
  evaluateRefund,
  isLiveData,
  LIVE_DATA_CLASSES,
  negotiate,
  quoteExpiry,
  type RefundPolicy,
} from '../../src/commerce/index.js';

const now = new Date('2026-09-27T20:30:00Z');

const quote = (overrides: Partial<ApprovableQuote> = {}): ApprovableQuote => ({
  state: 'ready',
  hash: 'a'.repeat(64),
  cartRevision: 3,
  currentCartRevision: 3,
  principalId: 'customer-1',
  expiresAt: new Date('2026-09-27T21:00:00Z'),
  approver: 'customer',
  merchantActive: true,
  ...overrides,
});

const attempt = (overrides: Partial<ApprovalAttempt> = {}): ApprovalAttempt => ({
  kind: 'customer',
  principalId: 'customer-1',
  quoteHash: 'a'.repeat(64),
  cartRevision: 3,
  now,
  ...overrides,
});

describe('quote approval binding (C04)', () => {
  it('accepts the exact quote from the customer it was made for', () => {
    expect(checkQuoteApproval(quote(), attempt())).toEqual({ ok: true });
  });

  it.each([
    ['an expired quote', quote({ expiresAt: now }), attempt(), 'expired'],
    ['a quote marked expired', quote({ state: 'expired' }), attempt(), 'expired'],
    ['an approved quote again', quote({ state: 'approved' }), attempt(), 'not_ready'],
    ['a superseded quote', quote({ state: 'superseded' }), attempt(), 'not_ready'],
    ['a changed cart', quote({ currentCartRevision: 4 }), attempt(), 'cart_changed'],
    ['an old cart revision', quote(), attempt({ cartRevision: 2 }), 'cart_changed'],
    ['another hash', quote(), attempt({ quoteHash: 'b'.repeat(64) }), 'hash_mismatch'],
    ['another customer', quote(), attempt({ principalId: 'customer-2' }), 'wrong_customer'],
    ['a staff-only action', quote({ approver: 'staff' }), attempt(), 'staff_only'],
    [
      'staff approving for a customer',
      quote(),
      attempt({ kind: 'staff', principalId: null }),
      'customer_only',
    ],
    ['a disabled merchant', quote({ merchantActive: false }), attempt(), 'merchant_inactive'],
  ] as const)('refuses %s', (_label, q, a, reason) => {
    expect(checkQuoteApproval(q, a)).toEqual({ ok: false, reason });
  });

  it('expires quotes at the merchant validity or the ceiling, whichever is first', () => {
    expect(quoteExpiry(now, null, 15)).toEqual(new Date('2026-09-27T20:45:00Z'));
    expect(quoteExpiry(now, new Date('2026-09-27T20:40:00Z'), 15)).toEqual(
      new Date('2026-09-27T20:40:00Z'),
    );
    expect(quoteExpiry(now, new Date('2026-09-28T00:00:00Z'), 15)).toEqual(
      new Date('2026-09-27T20:45:00Z'),
    );
  });
});

const capabilities = (overrides: Partial<CommerceCapabilities> = {}): CommerceCapabilities => ({
  version: 1,
  provider: 'mock',
  apiVersion: 'test',
  catalog: { search: true, variants: true, stock: true },
  checkout: { hosted: true, authorizationOnly: false },
  refunds: { full: true, partial: true },
  cancellation: false,
  recurring: false,
  provisioning: false,
  currencies: ['AED', 'USD'],
  countries: ['AE'],
  tax: 'included',
  ...overrides,
});

describe('refund policy (C12)', () => {
  const facts = {
    amountMinor: 1500n,
    capturedMinor: 6000n,
    refundedMinor: 0n,
    inFlightMinor: 0n,
    paidAt: new Date('2026-09-27T10:08:00Z'),
    now,
  };

  it('computes eligibility from captured, refunded and in-flight amounts', () => {
    expect(evaluateRefund(DEFAULT_REFUND_POLICY, capabilities(), facts)).toEqual({
      eligible: true,
      reasons: [],
      refundableMinor: 6000n,
      needsApproval: true,
      partial: true,
    });
    const over = evaluateRefund(DEFAULT_REFUND_POLICY, capabilities(), {
      ...facts,
      amountMinor: 1500n,
      refundedMinor: 3500n,
      inFlightMinor: 1500n,
    });
    expect(over.eligible).toBe(false);
    expect(over.reasons).toEqual(['exceeds_refundable']);
    expect(over.refundableMinor).toBe(1000n);
    expect(
      evaluateRefund(DEFAULT_REFUND_POLICY, capabilities(), { ...facts, amountMinor: 0n }).reasons,
    ).toContain('not_positive');
    expect(
      evaluateRefund(DEFAULT_REFUND_POLICY, capabilities(), { ...facts, capturedMinor: 0n })
        .reasons,
    ).toEqual(['nothing_captured', 'exceeds_refundable']);
  });

  it('respects the provider: partial refunds only where supported', () => {
    const fullOnly = capabilities({ refunds: { full: true, partial: false } });
    expect(evaluateRefund(DEFAULT_REFUND_POLICY, fullOnly, facts).reasons).toEqual([
      'partial_not_supported',
    ]);
    expect(
      evaluateRefund(DEFAULT_REFUND_POLICY, fullOnly, { ...facts, amountMinor: 6000n }).eligible,
    ).toBe(true);
    const none = capabilities({ refunds: { full: false, partial: false } });
    expect(evaluateRefund(DEFAULT_REFUND_POLICY, none, facts).reasons).toContain(
      'refunds_not_supported',
    );
  });

  it('applies the refund window and the approval threshold', () => {
    const windowed: RefundPolicy = { ...DEFAULT_REFUND_POLICY, windowDays: 14 };
    expect(
      evaluateRefund(windowed, capabilities(), { ...facts, now: new Date('2026-10-20T00:00:00Z') })
        .reasons,
    ).toEqual(['outside_window']);
    const threshold: RefundPolicy = {
      ...DEFAULT_REFUND_POLICY,
      approval: 'above_threshold',
      autoApproveMaxMinor: 2000n,
    };
    expect(evaluateRefund(threshold, capabilities(), facts).needsApproval).toBe(false);
    expect(
      evaluateRefund(threshold, capabilities(), { ...facts, amountMinor: 2001n }).needsApproval,
    ).toBe(true);
    expect(evaluateRefund(DEFAULT_REFUND_POLICY, capabilities(), facts).needsApproval).toBe(true);
  });

  it('keeps the requester from approving their own refund when the policy says so', () => {
    expect(checkRefundApprover(DEFAULT_REFUND_POLICY, 'staff-1', 'staff-1')).toEqual({
      ok: false,
      reason: 'same_person',
    });
    expect(checkRefundApprover(DEFAULT_REFUND_POLICY, 'staff-1', 'staff-2')).toEqual({ ok: true });
    expect(
      checkRefundApprover(
        { ...DEFAULT_REFUND_POLICY, requireSeparateApprover: false },
        'staff-1',
        'staff-1',
      ),
    ).toEqual({ ok: true });
  });
});

describe('capability negotiation (E02)', () => {
  it('allows what the manifest declares', () => {
    expect(negotiate(capabilities(), 'checkout.hosted', { currency: 'AED' })).toEqual({
      supported: true,
    });
    expect(negotiate(capabilities(), 'refund.partial')).toEqual({ supported: true });
  });

  it('refuses the rest predictably, with a recovery path', () => {
    expect(negotiate(capabilities(), 'subscription.start')).toEqual({
      supported: false,
      reason: 'operation_not_supported',
      recovery: 'one_time_purchase_only',
    });
    expect(negotiate(capabilities(), 'checkout.authorize_only')).toEqual({
      supported: false,
      reason: 'operation_not_supported',
      recovery: 'use_hosted_checkout',
    });
    expect(
      negotiate(capabilities({ refunds: { full: true, partial: false } }), 'refund.partial'),
    ).toEqual({
      supported: false,
      reason: 'operation_not_supported',
      recovery: 'full_refund_only',
    });
    expect(
      negotiate(capabilities({ refunds: { full: false, partial: false } }), 'refund.partial'),
    ).toEqual({ supported: false, reason: 'operation_not_supported', recovery: 'contact_team' });
    expect(negotiate(capabilities(), 'quote', { currency: 'PKR' })).toEqual({
      supported: false,
      reason: 'currency_not_supported',
      recovery: 'choose_supported_currency',
    });
    expect(negotiate(capabilities(), 'quote', { currency: 'AED', country: 'PK' })).toEqual({
      supported: false,
      reason: 'country_not_supported',
      recovery: 'contact_team',
    });
    expect(negotiate(capabilities(), 'provisioning.accept').supported).toBe(false);
    expect(negotiate(capabilities(), 'order.cancel').supported).toBe(false);
    expect(negotiate(capabilities({ currencies: [] }), 'quote').supported).toBe(false);
    expect(
      negotiate(
        capabilities({ catalog: { search: false, variants: false, stock: false } }),
        'catalog.search',
      ),
    ).toEqual({ supported: false, reason: 'operation_not_supported', recovery: 'ask_merchant' });
  });
});

describe('live data exclusions (K06)', () => {
  it('never lets an answer that used prices, stock or order state into a cache', () => {
    for (const dataClass of LIVE_DATA_CLASSES) {
      expect(isLiveData(dataClass)).toBe(true);
      expect(answerCacheDecision(['knowledge.article', dataClass])).toEqual({
        cacheable: false,
        reason: 'live_commerce_data',
        classes: [dataClass],
      });
    }
    // A class added later under commerce. is excluded too.
    expect(answerCacheDecision(['commerce.subscription_status']).cacheable).toBe(false);
    expect(answerCacheDecision(['knowledge.article', 'faq.shipping'])).toEqual({ cacheable: true });
  });
});
