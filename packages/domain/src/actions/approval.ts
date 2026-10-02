import type { ActionState } from './machine.js';
import type { Approver } from './policy.js';

/**
 * Approval binding (G13). An approval names exactly what the approver saw: the SHA-256 of the
 * canonical arguments, the tool definition revision, the revision of the resource it acts on and
 * the conversation's ownership epoch. It expires, and a change to any bound value refuses it (and
 * supersedes the action): a new proposal needs a new approval. The model never approves; approvals
 * come from an authenticated customer or staff member, and a customer can never approve an action
 * that needs staff.
 */

export interface BoundAction {
  state: ActionState;
  approver: Approver;
  /** The customer the action was proposed for (their own request), when there is one. */
  principalId: string | null;
  expiresAt: Date;
  argumentsHash: string;
  toolRevision: number;
  resourceRevision: string | null;
  ownerEpoch: number;
}

/** The values the approval is bound to, as they are now. */
export interface CurrentBinding {
  toolRevision: number;
  /** Tool still enabled and not stopped by a kill switch. */
  toolUsable: boolean;
  /** The resource's revision read again now; null when the tool has no resource. */
  resourceRevision: string | null;
  ownerEpoch: number;
}

export interface ApprovalAttempt {
  kind: Approver;
  /** The approving customer (customer approvals). */
  principalId: string | null;
  /** The arguments hash the approver was shown (from the card). */
  argumentsHash: string;
  now: Date;
}

export type ApprovalRefusal =
  | 'staff_only'
  | 'customer_only'
  | 'wrong_customer'
  | 'not_pending'
  | 'expired'
  | 'arguments_changed'
  | 'tool_changed'
  | 'resource_changed'
  | 'owner_changed';

export type BindingCheck = { ok: true } | { ok: false; reason: ApprovalRefusal };

/** Refusals that mean the action is no longer what was proposed: it is superseded. */
export const SUPERSEDING: ReadonlySet<ApprovalRefusal> = new Set([
  'tool_changed',
  'resource_changed',
  'owner_changed',
]);

/**
 * The bound values rechecked, in a fixed order (also right before execution). The arguments
 * never change after the proposal (the database refuses it); a different hash means the approver
 * looked at something else.
 */
export function checkBinding(
  action: BoundAction,
  current: CurrentBinding,
  seenArgumentsHash: string = action.argumentsHash,
): BindingCheck {
  if (seenArgumentsHash !== action.argumentsHash) return { ok: false, reason: 'arguments_changed' };
  if (!current.toolUsable || current.toolRevision !== action.toolRevision) {
    return { ok: false, reason: 'tool_changed' };
  }
  if ((current.resourceRevision ?? null) !== (action.resourceRevision ?? null)) {
    return { ok: false, reason: 'resource_changed' };
  }
  if (current.ownerEpoch !== action.ownerEpoch) return { ok: false, reason: 'owner_changed' };
  return { ok: true };
}

export function checkActionApproval(
  action: BoundAction,
  attempt: ApprovalAttempt,
  current: CurrentBinding,
): BindingCheck {
  const refuse = (reason: ApprovalRefusal): BindingCheck => ({ ok: false, reason });
  // Who is asking comes first: nobody learns the action's state by trying the wrong door.
  if (action.approver === 'staff' && attempt.kind === 'customer') return refuse('staff_only');
  if (action.approver === 'customer' && attempt.kind === 'staff') return refuse('customer_only');
  if (attempt.kind === 'customer' && attempt.principalId !== action.principalId) {
    return refuse('wrong_customer');
  }
  if (action.state === 'expired') return refuse('expired');
  if (action.state !== 'awaiting_approval') return refuse('not_pending');
  if (attempt.now.getTime() >= action.expiresAt.getTime()) return refuse('expired');
  return checkBinding(action, current, attempt.argumentsHash);
}

/** Minutes an approval stays open by default, and the ceiling a tool may ask for. */
export const APPROVAL_MINUTES = { customer: 30, staff: 24 * 60, max: 7 * 24 * 60 } as const;

export function approvalExpiry(now: Date, approver: Approver, minutes?: number): Date {
  const chosen = Math.min(minutes ?? APPROVAL_MINUTES[approver], APPROVAL_MINUTES.max);
  return new Date(now.getTime() + Math.max(1, chosen) * 60_000);
}
