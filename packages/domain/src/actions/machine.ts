import type { Machine } from '../commerce/machines.js';

/**
 * An AI action (G13, G14): a tool call the runtime accepted for consideration. It is refused
 * (`denied`), waits for approval, or is approved (by a person, or by autopilot policy); approved
 * actions are dispatched once; the outcome is `completed` or `failed` only from the tool's own
 * answer, and `unknown` (reconciled, never resent blindly) when the answer was lost. A change to
 * anything the approval was bound to supersedes it; a takeover or a stopped run cancels what has
 * not been sent yet.
 */
export const ACTION_STATES = [
  'awaiting_approval',
  'approved',
  'executing',
  'completed',
  'failed',
  'unknown',
  'declined',
  'expired',
  'superseded',
  'cancelled',
  'denied',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_EVENTS = [
  'approve',
  'decline',
  'expire',
  'supersede',
  'cancel',
  'dispatch',
  'succeed',
  'fail',
  'lose_track',
] as const;
export type ActionEvent = (typeof ACTION_EVENTS)[number];

export const actionMachine: Machine<ActionState, ActionEvent> = {
  name: 'action',
  states: ACTION_STATES,
  events: ACTION_EVENTS,
  initial: 'awaiting_approval',
  terminal: ['completed', 'failed', 'declined', 'expired', 'superseded', 'cancelled', 'denied'],
  transitions: {
    awaiting_approval: {
      approve: 'approved',
      decline: 'declined',
      expire: 'expired',
      supersede: 'superseded',
      cancel: 'cancelled',
    },
    approved: { dispatch: 'executing', supersede: 'superseded', cancel: 'cancelled' },
    // Once sent, only the tool's answer (or reconciliation) settles it; cancelling cannot unsend.
    executing: { succeed: 'completed', fail: 'failed', lose_track: 'unknown' },
    unknown: { succeed: 'completed', fail: 'failed' },
    completed: {},
    failed: {},
    declined: {},
    expired: {},
    superseded: {},
    cancelled: {},
    denied: {},
  },
};

/** States in which something may still happen (shown to whoever takes over). */
export const OPEN_ACTION_STATES: readonly ActionState[] = [
  'awaiting_approval',
  'approved',
  'executing',
  'unknown',
];

/** Sent and not settled: another attempt must wait for reconciliation. */
export const IN_FLIGHT_ACTION_STATES: readonly ActionState[] = ['executing', 'unknown'];

/**
 * What the customer and staff see: an action is "completed" only with the tool's answer, and an
 * unconfirmed outcome is said plainly (UX: "Action outcome unconfirmed").
 */
export type ActionOutcome =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export function actionOutcome(state: ActionState): ActionOutcome {
  switch (state) {
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'approved':
      return 'approved';
    case 'executing':
      return 'executing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      return 'cancelled';
  }
}
