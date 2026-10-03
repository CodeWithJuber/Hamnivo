import { describe, expect, it } from 'vitest';
import {
  approvalExpiry,
  approvalNeedsStepUp,
  type BoundAction,
  type CurrentBinding,
  checkActionApproval,
  checkBinding,
  toolPolicyProblems,
} from '../../src/actions/index.js';

const now = new Date('2026-09-27T12:00:00Z');
const hash = 'a'.repeat(64);

const action = (overrides: Partial<BoundAction> = {}): BoundAction => ({
  state: 'awaiting_approval',
  approver: 'customer',
  principalId: 'cus-1',
  expiresAt: new Date(now.getTime() + 30 * 60_000),
  argumentsHash: hash,
  toolRevision: 3,
  resourceRevision: 'r7',
  ownerEpoch: 4,
  ...overrides,
});

const current = (overrides: Partial<CurrentBinding> = {}): CurrentBinding => ({
  toolRevision: 3,
  toolUsable: true,
  resourceRevision: 'r7',
  ownerEpoch: 4,
  ...overrides,
});

const customer = { kind: 'customer' as const, principalId: 'cus-1', argumentsHash: hash, now };
const staff = { kind: 'staff' as const, principalId: null, argumentsHash: hash, now };

describe('checkActionApproval', () => {
  it('accepts the exact action from the right approver', () => {
    expect(checkActionApproval(action(), customer, current())).toEqual({ ok: true });
    expect(checkActionApproval(action({ approver: 'staff' }), staff, current())).toEqual({
      ok: true,
    });
  });

  it('never lets a customer approve a staff-only action, even with everything else right', () => {
    expect(checkActionApproval(action({ approver: 'staff' }), customer, current())).toEqual({
      ok: false,
      reason: 'staff_only',
    });
  });

  it('does not let staff approve on the customer’s behalf, nor another customer', () => {
    expect(checkActionApproval(action(), staff, current())).toEqual({
      ok: false,
      reason: 'customer_only',
    });
    expect(checkActionApproval(action(), { ...customer, principalId: 'cus-2' }, current())).toEqual(
      { ok: false, reason: 'wrong_customer' },
    );
  });

  it('refuses a replay with changed arguments', () => {
    expect(
      checkActionApproval(action(), { ...customer, argumentsHash: 'b'.repeat(64) }, current()),
    ).toEqual({ ok: false, reason: 'arguments_changed' });
  });

  it.each([
    [{ toolRevision: 4 }, 'tool_changed'],
    [{ toolUsable: false }, 'tool_changed'],
    [{ resourceRevision: 'r8' }, 'resource_changed'],
    [{ resourceRevision: null }, 'resource_changed'],
    [{ ownerEpoch: 5 }, 'owner_changed'],
  ] as const)('refuses when a bound value changed: %j', (change, reason) => {
    expect(checkActionApproval(action(), customer, current(change))).toEqual({
      ok: false,
      reason,
    });
  });

  it('expires at the deadline, not after it', () => {
    const at = action().expiresAt;
    expect(checkActionApproval(action(), { ...customer, now: at }, current())).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      checkActionApproval(action(), { ...customer, now: new Date(at.getTime() - 1) }, current()),
    ).toEqual({ ok: true });
  });

  it('refuses a second decision', () => {
    expect(checkActionApproval(action({ state: 'approved' }), customer, current())).toEqual({
      ok: false,
      reason: 'not_pending',
    });
  });

  it('rechecks the binding before execution', () => {
    expect(checkBinding(action({ state: 'approved' }), current())).toEqual({ ok: true });
    expect(checkBinding(action({ state: 'approved' }), current({ ownerEpoch: 9 }))).toEqual({
      ok: false,
      reason: 'owner_changed',
    });
  });
});

describe('policy rules', () => {
  it('keeps money and irreversible actions with staff and off autopilot', () => {
    expect(
      toolPolicyProblems({
        risk: 'money',
        approver: 'customer',
        autopilot: true,
        customerStepUp: false,
      })
        .map((p) => p.path)
        .sort(),
    ).toEqual(['approver', 'autopilot']);
    expect(
      toolPolicyProblems({
        risk: 'write',
        approver: 'customer',
        autopilot: true,
        customerStepUp: true,
      }),
    ).toEqual([]);
    expect(
      toolPolicyProblems({
        risk: 'read',
        approver: 'staff',
        autopilot: false,
        customerStepUp: true,
      }).map((p) => p.path),
    ).toEqual(['customerStepUp']);
  });

  it('asks staff for a fresh sign-in only for money and irreversible actions', () => {
    expect(approvalNeedsStepUp({ risk: 'money', approver: 'staff', customerStepUp: false })).toBe(
      true,
    );
    expect(
      approvalNeedsStepUp({ risk: 'irreversible', approver: 'staff', customerStepUp: false }),
    ).toBe(true);
    expect(approvalNeedsStepUp({ risk: 'write', approver: 'staff', customerStepUp: false })).toBe(
      false,
    );
    expect(approvalNeedsStepUp({ risk: 'write', approver: 'customer', customerStepUp: true })).toBe(
      true,
    );
  });

  it('bounds approval expiry', () => {
    expect(approvalExpiry(now, 'customer').toISOString()).toBe('2026-09-27T12:30:00.000Z');
    expect(approvalExpiry(now, 'staff', 10 * 24 * 60).getTime() - now.getTime()).toBe(
      7 * 24 * 60 * 60_000,
    );
  });
});
