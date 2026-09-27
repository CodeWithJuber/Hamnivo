/**
 * Commerce lifecycles as explicit state machines (blueprint §23). Each record moves only through
 * a listed transition; anything else is refused, so a late or repeated event cannot move a paid
 * order back to pending. The machines are separate on purpose: payment, order, fulfilment and
 * refund states are never collapsed into one status.
 */

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly initial: S;
  /** States no event leaves. */
  readonly terminal: readonly S[];
  readonly transitions: { readonly [K in S]: { readonly [V in E]?: S } };
}

export class IllegalTransitionError extends Error {
  override name = 'IllegalTransitionError';
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
  ) {
    super(`${machine}: "${event}" is not allowed in state "${from}"`);
  }
}

/** The next state, or null when the event is not allowed in this state. */
export function nextState<S extends string, E extends string>(
  machine: Machine<S, E>,
  from: S,
  event: E,
): S | null {
  return machine.transitions[from]?.[event] ?? null;
}

export function transition<S extends string, E extends string>(
  machine: Machine<S, E>,
  from: S,
  event: E,
): S {
  const to = nextState(machine, from, event);
  if (to === null) throw new IllegalTransitionError(machine.name, from, event);
  return to;
}

export function isTerminal<S extends string, E extends string>(
  machine: Machine<S, E>,
  state: S,
): boolean {
  return machine.terminal.includes(state);
}

function define<const S extends string, const E extends string>(machine: Machine<S, E>) {
  return machine;
}

/** A customer's cart. Editing bumps the revision; an approved checkout locks it. */
export const cartMachine = define({
  name: 'cart',
  states: ['open', 'locked', 'completed', 'abandoned'],
  events: ['edit', 'lock', 'release', 'complete', 'abandon'],
  initial: 'open',
  terminal: ['completed', 'abandoned'],
  transitions: {
    open: { edit: 'open', lock: 'locked', abandon: 'abandoned' },
    // A failed, expired or cancelled payment releases the cart as it was (preserved cart).
    locked: { release: 'open', complete: 'completed' },
    completed: {},
    abandoned: {},
  },
});

/** A priced quote from the merchant. It is approved once, then consumed by one checkout. */
export const quoteMachine = define({
  name: 'quote',
  states: ['ready', 'approved', 'consumed', 'expired', 'superseded', 'cancelled'],
  events: ['approve', 'consume', 'expire', 'supersede', 'cancel'],
  initial: 'ready',
  terminal: ['consumed', 'expired', 'superseded', 'cancelled'],
  transitions: {
    ready: { approve: 'approved', expire: 'expired', supersede: 'superseded', cancel: 'cancelled' },
    approved: { consume: 'consumed', supersede: 'superseded', cancel: 'cancelled' },
    consumed: {},
    expired: {},
    superseded: {},
    cancelled: {},
  },
});

/**
 * Purchase intent: draft → quoted → awaiting approval → approved → executing → completed, with
 * expired, cancelled, denied, needs-human and outcome-unknown branches (blueprint §23).
 */
export const purchaseIntentMachine = define({
  name: 'purchase_intent',
  states: [
    'draft',
    'quoted',
    'awaiting_approval',
    'approved',
    'executing',
    'completed',
    'expired',
    'cancelled',
    'denied',
    'failed',
    'needs_human',
    'unknown',
  ],
  events: [
    'quote',
    'present',
    'approve',
    'deny',
    'expire',
    'cancel',
    'dispatch',
    'dispatch_unknown',
    'reconciled',
    'payment_succeeded',
    'payment_failed',
    'dispatch_failed',
    'escalate',
  ],
  initial: 'draft',
  terminal: ['completed', 'expired', 'cancelled', 'denied', 'failed'],
  transitions: {
    draft: { quote: 'quoted', cancel: 'cancelled' },
    quoted: { present: 'awaiting_approval', expire: 'expired', cancel: 'cancelled' },
    awaiting_approval: {
      approve: 'approved',
      deny: 'denied',
      expire: 'expired',
      cancel: 'cancelled',
    },
    approved: {
      dispatch: 'executing',
      dispatch_unknown: 'unknown',
      // The provider refused to open a payment page: nothing can have been charged.
      dispatch_failed: 'failed',
      cancel: 'cancelled',
      escalate: 'needs_human',
    },
    executing: {
      payment_succeeded: 'completed',
      payment_failed: 'failed',
      // The hosted page timed out unpaid.
      expire: 'expired',
      cancel: 'cancelled',
      escalate: 'needs_human',
    },
    // A timed-out checkout request is resolved from the provider, never by asking again blindly.
    unknown: {
      reconciled: 'executing',
      payment_succeeded: 'completed',
      payment_failed: 'failed',
      dispatch_failed: 'failed',
      escalate: 'needs_human',
    },
    needs_human: {
      reconciled: 'executing',
      payment_succeeded: 'completed',
      payment_failed: 'failed',
      cancel: 'cancelled',
    },
    completed: {},
    expired: {},
    cancelled: {},
    denied: {},
    failed: {},
  },
});

/**
 * Payment at the provider: not started → requires action / processing → authorized → captured.
 * Refunds and disputes are related records; a captured payment stays captured.
 */
export const paymentMachine = define({
  name: 'payment',
  states: [
    'not_started',
    'requires_action',
    'processing',
    'authorized',
    'captured',
    'failed',
    'cancelled',
    'unknown',
  ],
  events: [
    'require_action',
    'process',
    'authorize',
    'capture',
    'fail',
    'cancel',
    'retry',
    'lose_track',
  ],
  initial: 'not_started',
  terminal: ['captured', 'failed', 'cancelled'],
  transitions: {
    not_started: {
      require_action: 'requires_action',
      process: 'processing',
      authorize: 'authorized',
      capture: 'captured',
      fail: 'failed',
      cancel: 'cancelled',
      lose_track: 'unknown',
    },
    requires_action: {
      process: 'processing',
      authorize: 'authorized',
      capture: 'captured',
      fail: 'failed',
      cancel: 'cancelled',
      // A declined attempt on the hosted page; the customer may try again there.
      retry: 'not_started',
      lose_track: 'unknown',
    },
    processing: {
      require_action: 'requires_action',
      authorize: 'authorized',
      capture: 'captured',
      fail: 'failed',
      lose_track: 'unknown',
    },
    authorized: { capture: 'captured', cancel: 'cancelled', lose_track: 'unknown' },
    // Only the provider's answer resolves an unknown payment.
    unknown: {
      require_action: 'requires_action',
      process: 'processing',
      authorize: 'authorized',
      capture: 'captured',
      fail: 'failed',
      cancel: 'cancelled',
      retry: 'not_started',
    },
    captured: {},
    failed: {},
    cancelled: {},
  },
});

/** The merchant order: submitted → confirmed → partially fulfilled → fulfilled. */
export const orderMachine = define({
  name: 'order',
  states: [
    'draft',
    'submitted',
    'confirmed',
    'partially_fulfilled',
    'fulfilled',
    'cancel_requested',
    'cancelled',
    'returned',
  ],
  events: ['submit', 'confirm', 'fulfil_part', 'fulfil', 'request_cancel', 'cancel', 'return'],
  initial: 'draft',
  terminal: ['cancelled', 'returned'],
  transitions: {
    draft: { submit: 'submitted', cancel: 'cancelled' },
    // An order whose payment never completes is cancelled; it was never confirmed.
    submitted: { confirm: 'confirmed', cancel: 'cancelled' },
    confirmed: {
      fulfil_part: 'partially_fulfilled',
      fulfil: 'fulfilled',
      request_cancel: 'cancel_requested',
    },
    partially_fulfilled: {
      fulfil_part: 'partially_fulfilled',
      fulfil: 'fulfilled',
      request_cancel: 'cancel_requested',
    },
    fulfilled: { return: 'returned' },
    cancel_requested: { cancel: 'cancelled', confirm: 'confirmed' },
    cancelled: {},
    returned: {},
  },
});

/**
 * Fulfilment of an order: shipments and service provisioning keep their own state, so "paid",
 * "provisioned" and "shipped" never mean each other (C10).
 */
export const fulfillmentMachine = define({
  name: 'fulfillment',
  states: [
    'pending',
    'in_progress',
    'delayed',
    'shipped',
    'delivered',
    'provisioned',
    'failed',
    'cancelled',
  ],
  events: ['start', 'delay', 'ship', 'deliver', 'provision', 'fail', 'cancel'],
  initial: 'pending',
  terminal: ['delivered', 'provisioned', 'cancelled'],
  transitions: {
    pending: { start: 'in_progress', delay: 'delayed', fail: 'failed', cancel: 'cancelled' },
    in_progress: {
      delay: 'delayed',
      ship: 'shipped',
      provision: 'provisioned',
      fail: 'failed',
      cancel: 'cancelled',
    },
    delayed: { start: 'in_progress', ship: 'shipped', provision: 'provisioned', fail: 'failed' },
    shipped: { deliver: 'delivered', delay: 'delayed', fail: 'failed' },
    // A failed step can be retried by the merchant (for example provisioning again).
    failed: { start: 'in_progress', cancel: 'cancelled' },
    delivered: {},
    provisioned: {},
    cancelled: {},
  },
});

/**
 * Refund: requested → policy checked → awaiting approval → submitted → pending → succeeded, with
 * rejected, failed and unknown branches. "Submitted" is not refunded; only the provider's answer
 * makes it succeeded (C12, X10).
 */
export const refundMachine = define({
  name: 'refund',
  states: [
    'requested',
    'policy_checked',
    'awaiting_approval',
    'submitted',
    'pending',
    'succeeded',
    'rejected',
    'failed',
    'unknown',
  ],
  events: [
    'policy_passed',
    'policy_failed',
    'needs_approval',
    'auto_approve',
    'approve',
    'reject',
    'provider_pending',
    'provider_succeeded',
    'provider_failed',
    'outcome_unknown',
  ],
  initial: 'requested',
  terminal: ['succeeded', 'rejected', 'failed'],
  transitions: {
    requested: { policy_passed: 'policy_checked', policy_failed: 'rejected' },
    policy_checked: { needs_approval: 'awaiting_approval', auto_approve: 'submitted' },
    awaiting_approval: { approve: 'submitted', reject: 'rejected' },
    submitted: {
      provider_pending: 'pending',
      provider_succeeded: 'succeeded',
      provider_failed: 'failed',
      outcome_unknown: 'unknown',
    },
    pending: { provider_succeeded: 'succeeded', provider_failed: 'failed' },
    unknown: {
      provider_pending: 'pending',
      provider_succeeded: 'succeeded',
      provider_failed: 'failed',
    },
    succeeded: {},
    rejected: {},
    failed: {},
  },
});

/**
 * One external call in the operation ledger (C07). A timeout after sending is `unknown` until the
 * provider is asked; only then does it become succeeded or failed.
 */
export const operationMachine = define({
  name: 'operation',
  states: ['pending', 'dispatched', 'succeeded', 'failed', 'unknown', 'cancelled'],
  events: ['dispatch', 'succeed', 'fail', 'lose_track', 'cancel'],
  initial: 'pending',
  terminal: ['succeeded', 'failed', 'cancelled'],
  transitions: {
    pending: { dispatch: 'dispatched', cancel: 'cancelled', fail: 'failed' },
    dispatched: { succeed: 'succeeded', fail: 'failed', lose_track: 'unknown' },
    unknown: { succeed: 'succeeded', fail: 'failed', dispatch: 'dispatched' },
    succeeded: {},
    failed: {},
    cancelled: {},
  },
});

export type CartState = (typeof cartMachine.states)[number];
export type QuoteState = (typeof quoteMachine.states)[number];
export type PurchaseIntentState = (typeof purchaseIntentMachine.states)[number];
export type PaymentState = (typeof paymentMachine.states)[number];
export type OrderState = (typeof orderMachine.states)[number];
export type FulfillmentState = (typeof fulfillmentMachine.states)[number];
export type RefundState = (typeof refundMachine.states)[number];
export type OperationState = (typeof operationMachine.states)[number];

export const COMMERCE_MACHINES = [
  cartMachine,
  quoteMachine,
  purchaseIntentMachine,
  paymentMachine,
  orderMachine,
  fulfillmentMachine,
  refundMachine,
  operationMachine,
] as const;
