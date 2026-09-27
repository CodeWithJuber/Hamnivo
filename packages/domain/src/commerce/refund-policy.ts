import type { CommerceCapabilities } from './capabilities.js';

/**
 * Refund rules (C12). Eligibility and the exact amount are computed here from the order's
 * captured and already-refunded amounts; nobody's wording or mood changes them. Approval is by a
 * person with the right permission, and with `requireSeparateApprover` never by the requester.
 */
export interface RefundPolicy {
  /** `always`: every refund needs approval. `above_threshold`: small refunds go straight through. */
  approval: 'always' | 'above_threshold';
  /** With `above_threshold`: refunds up to this many minor units need no approval. */
  autoApproveMaxMinor: bigint;
  /** The person who asked for a refund cannot approve it. */
  requireSeparateApprover: boolean;
  /** Days after payment in which refunds are allowed; null means no limit. */
  windowDays: number | null;
}

export const DEFAULT_REFUND_POLICY: RefundPolicy = {
  approval: 'always',
  autoApproveMaxMinor: 0n,
  requireSeparateApprover: true,
  windowDays: null,
};

export interface RefundRequestFacts {
  amountMinor: bigint;
  /** Captured on the payment. */
  capturedMinor: bigint;
  /** Already refunded (succeeded). */
  refundedMinor: bigint;
  /** Requested, approved or submitted but not finished: counted so two requests cannot overpay. */
  inFlightMinor: bigint;
  paidAt: Date;
  now: Date;
}

export type RefundIneligibility =
  | 'not_positive'
  | 'nothing_captured'
  | 'exceeds_refundable'
  | 'outside_window'
  | 'partial_not_supported'
  | 'refunds_not_supported';

export interface RefundEvaluation {
  eligible: boolean;
  reasons: RefundIneligibility[];
  /** Largest amount that could still be refunded now. */
  refundableMinor: bigint;
  needsApproval: boolean;
  partial: boolean;
}

export function evaluateRefund(
  policy: RefundPolicy,
  capabilities: Pick<CommerceCapabilities, 'refunds'>,
  facts: RefundRequestFacts,
): RefundEvaluation {
  const reasons: RefundIneligibility[] = [];
  const refundable = facts.capturedMinor - facts.refundedMinor - facts.inFlightMinor;
  const refundableMinor = refundable > 0n ? refundable : 0n;
  const partial = facts.amountMinor < facts.capturedMinor;
  if (!capabilities.refunds.full && !capabilities.refunds.partial) {
    reasons.push('refunds_not_supported');
  }
  if (facts.amountMinor <= 0n) reasons.push('not_positive');
  if (facts.capturedMinor <= 0n) reasons.push('nothing_captured');
  if (facts.amountMinor > refundableMinor) reasons.push('exceeds_refundable');
  if (partial && !capabilities.refunds.partial) reasons.push('partial_not_supported');
  if (policy.windowDays !== null) {
    const deadline = facts.paidAt.getTime() + policy.windowDays * 86_400_000;
    if (facts.now.getTime() > deadline) reasons.push('outside_window');
  }
  const needsApproval =
    policy.approval === 'always' || facts.amountMinor > policy.autoApproveMaxMinor;
  return { eligible: reasons.length === 0, reasons, refundableMinor, needsApproval, partial };
}

export type ApproverRefusal = 'same_person';

/** Separation of duties: with the policy on, the requester cannot approve their own request. */
export function checkRefundApprover(
  policy: RefundPolicy,
  requesterId: string,
  approverId: string,
): { ok: true } | { ok: false; reason: ApproverRefusal } {
  if (policy.requireSeparateApprover && requesterId === approverId) {
    return { ok: false, reason: 'same_person' };
  }
  return { ok: true };
}
