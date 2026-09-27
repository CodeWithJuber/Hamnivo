import { describe, expect, it } from 'vitest';
import {
  COMMERCE_MACHINES,
  cartMachine,
  fulfillmentMachine,
  IllegalTransitionError,
  isTerminal,
  type Machine,
  nextState,
  operationMachine,
  orderMachine,
  paymentMachine,
  purchaseIntentMachine,
  quoteMachine,
  refundMachine,
  transition,
} from '../../src/commerce/index.js';

/**
 * The allowed transitions, written out independently of the machine definitions. Each machine
 * must allow exactly these; every other (state, event) pair must be refused.
 */
const EXPECTED: Record<string, string[]> = {
  cart: [
    'open --edit--> open',
    'open --lock--> locked',
    'open --abandon--> abandoned',
    'locked --release--> open',
    'locked --complete--> completed',
  ],
  quote: [
    'ready --approve--> approved',
    'ready --expire--> expired',
    'ready --supersede--> superseded',
    'ready --cancel--> cancelled',
    'approved --consume--> consumed',
    'approved --supersede--> superseded',
    'approved --cancel--> cancelled',
  ],
  purchase_intent: [
    'draft --quote--> quoted',
    'draft --cancel--> cancelled',
    'quoted --present--> awaiting_approval',
    'quoted --expire--> expired',
    'quoted --cancel--> cancelled',
    'awaiting_approval --approve--> approved',
    'awaiting_approval --deny--> denied',
    'awaiting_approval --expire--> expired',
    'awaiting_approval --cancel--> cancelled',
    'approved --dispatch--> executing',
    'approved --dispatch_unknown--> unknown',
    'approved --dispatch_failed--> failed',
    'approved --cancel--> cancelled',
    'approved --escalate--> needs_human',
    'executing --payment_succeeded--> completed',
    'executing --payment_failed--> failed',
    'executing --expire--> expired',
    'executing --cancel--> cancelled',
    'executing --escalate--> needs_human',
    'unknown --reconciled--> executing',
    'unknown --payment_succeeded--> completed',
    'unknown --payment_failed--> failed',
    'unknown --dispatch_failed--> failed',
    'unknown --escalate--> needs_human',
    'needs_human --reconciled--> executing',
    'needs_human --payment_succeeded--> completed',
    'needs_human --payment_failed--> failed',
    'needs_human --cancel--> cancelled',
  ],
  payment: [
    'not_started --require_action--> requires_action',
    'not_started --process--> processing',
    'not_started --authorize--> authorized',
    'not_started --capture--> captured',
    'not_started --fail--> failed',
    'not_started --cancel--> cancelled',
    'not_started --lose_track--> unknown',
    'requires_action --process--> processing',
    'requires_action --authorize--> authorized',
    'requires_action --capture--> captured',
    'requires_action --fail--> failed',
    'requires_action --cancel--> cancelled',
    'requires_action --retry--> not_started',
    'requires_action --lose_track--> unknown',
    'processing --require_action--> requires_action',
    'processing --authorize--> authorized',
    'processing --capture--> captured',
    'processing --fail--> failed',
    'processing --lose_track--> unknown',
    'authorized --capture--> captured',
    'authorized --cancel--> cancelled',
    'authorized --lose_track--> unknown',
    'unknown --require_action--> requires_action',
    'unknown --process--> processing',
    'unknown --authorize--> authorized',
    'unknown --capture--> captured',
    'unknown --fail--> failed',
    'unknown --cancel--> cancelled',
    'unknown --retry--> not_started',
  ],
  order: [
    'draft --submit--> submitted',
    'draft --cancel--> cancelled',
    'submitted --confirm--> confirmed',
    'submitted --cancel--> cancelled',
    'confirmed --fulfil_part--> partially_fulfilled',
    'confirmed --fulfil--> fulfilled',
    'confirmed --request_cancel--> cancel_requested',
    'partially_fulfilled --fulfil_part--> partially_fulfilled',
    'partially_fulfilled --fulfil--> fulfilled',
    'partially_fulfilled --request_cancel--> cancel_requested',
    'fulfilled --return--> returned',
    'cancel_requested --cancel--> cancelled',
    'cancel_requested --confirm--> confirmed',
  ],
  fulfillment: [
    'pending --start--> in_progress',
    'pending --delay--> delayed',
    'pending --fail--> failed',
    'pending --cancel--> cancelled',
    'in_progress --delay--> delayed',
    'in_progress --ship--> shipped',
    'in_progress --provision--> provisioned',
    'in_progress --fail--> failed',
    'in_progress --cancel--> cancelled',
    'delayed --start--> in_progress',
    'delayed --ship--> shipped',
    'delayed --provision--> provisioned',
    'delayed --fail--> failed',
    'shipped --deliver--> delivered',
    'shipped --delay--> delayed',
    'shipped --fail--> failed',
    'failed --start--> in_progress',
    'failed --cancel--> cancelled',
  ],
  refund: [
    'requested --policy_passed--> policy_checked',
    'requested --policy_failed--> rejected',
    'policy_checked --needs_approval--> awaiting_approval',
    'policy_checked --auto_approve--> submitted',
    'awaiting_approval --approve--> submitted',
    'awaiting_approval --reject--> rejected',
    'submitted --provider_pending--> pending',
    'submitted --provider_succeeded--> succeeded',
    'submitted --provider_failed--> failed',
    'submitted --outcome_unknown--> unknown',
    'pending --provider_succeeded--> succeeded',
    'pending --provider_failed--> failed',
    'unknown --provider_pending--> pending',
    'unknown --provider_succeeded--> succeeded',
    'unknown --provider_failed--> failed',
  ],
  operation: [
    'pending --dispatch--> dispatched',
    'pending --cancel--> cancelled',
    'pending --fail--> failed',
    'dispatched --succeed--> succeeded',
    'dispatched --fail--> failed',
    'dispatched --lose_track--> unknown',
    'unknown --succeed--> succeeded',
    'unknown --fail--> failed',
    'unknown --dispatch--> dispatched',
  ],
};

type AnyMachine = Machine<string, string>;
const machines = COMMERCE_MACHINES as unknown as AnyMachine[];

describe.each(machines.map((m) => [m.name, m] as const))('%s machine', (_name, machine) => {
  const expected = new Map(
    (EXPECTED[machine.name] ?? []).map((line) => {
      const [, from, event, to] = /^(\w+) --(\w+)--> (\w+)$/.exec(line) ?? [];
      return [`${from}/${event}`, to];
    }),
  );

  it('is listed in the expected table', () => {
    expect(EXPECTED[machine.name]).toBeDefined();
  });

  it('allows exactly the expected transitions and refuses every other pair', () => {
    let checked = 0;
    for (const state of machine.states) {
      for (const event of machine.events) {
        const want = expected.get(`${state}/${event}`) ?? null;
        expect(nextState(machine, state, event), `${state} --${event}-->`).toBe(want);
        if (want === null) {
          expect(() => transition(machine, state, event)).toThrow(IllegalTransitionError);
        } else {
          expect(transition(machine, state, event)).toBe(want);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(machine.states.length * machine.events.length);
    // Nothing in the expected table refers to a state or event the machine does not know.
    for (const key of expected.keys()) {
      const [state, event] = key.split('/');
      expect(machine.states).toContain(state);
      expect(machine.events).toContain(event);
    }
  });

  it('has terminal states with no way out and every state reachable from the start', () => {
    expect(machine.states).toContain(machine.initial);
    for (const state of machine.terminal) {
      expect(isTerminal(machine, state)).toBe(true);
      expect(Object.keys(machine.transitions[state] ?? {})).toEqual([]);
    }
    const reached = new Set([machine.initial]);
    const queue = [machine.initial];
    while (queue.length) {
      const state = queue.shift() as string;
      for (const to of Object.values(machine.transitions[state] ?? {}) as string[]) {
        if (!reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    expect([...reached].sort()).toEqual([...machine.states].sort());
  });
});

describe('financial invariants', () => {
  it('never moves a captured payment backwards, whatever arrives late', () => {
    for (const event of paymentMachine.events) {
      expect(nextState(paymentMachine, 'captured', event)).toBeNull();
    }
    // An unknown payment is resolved only by what the provider reports.
    expect(nextState(paymentMachine, 'unknown', 'capture')).toBe('captured');
  });

  it('keeps a refund pending until the provider says it succeeded', () => {
    expect(nextState(refundMachine, 'awaiting_approval', 'provider_succeeded')).toBeNull();
    expect(nextState(refundMachine, 'requested', 'approve')).toBeNull();
    expect(nextState(refundMachine, 'rejected', 'approve')).toBeNull();
    expect(nextState(refundMachine, 'succeeded', 'provider_failed')).toBeNull();
  });

  it('refuses approval of an expired, superseded or consumed quote', () => {
    for (const state of ['expired', 'superseded', 'consumed', 'cancelled'] as const) {
      expect(nextState(quoteMachine, state, 'approve')).toBeNull();
    }
  });

  it('cannot confirm an order twice or undo a delivery', () => {
    expect(nextState(orderMachine, 'confirmed', 'confirm')).toBeNull();
    expect(nextState(orderMachine, 'fulfilled', 'cancel')).toBeNull();
    expect(nextState(fulfillmentMachine, 'delivered', 'fail')).toBeNull();
    expect(nextState(fulfillmentMachine, 'provisioned', 'ship')).toBeNull();
  });

  it('keeps a locked cart unchanged until the checkout ends', () => {
    expect(nextState(cartMachine, 'locked', 'edit')).toBeNull();
    expect(nextState(purchaseIntentMachine, 'unknown', 'dispatch')).toBeNull();
    expect(nextState(operationMachine, 'succeeded', 'dispatch')).toBeNull();
  });

  it('names the machine, state and event when refusing', () => {
    expect(() => transition(paymentMachine, 'captured', 'fail')).toThrow(
      'payment: "fail" is not allowed in state "captured"',
    );
  });
});
