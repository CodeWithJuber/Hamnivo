import type { QuoteState } from './machines.js';

/**
 * Approval binding (C04). An approval names the exact quote hash and cart revision the approver
 * saw. It is rechecked when it arrives: an expired quote, a changed cart, a different hash, the
 * wrong person or the wrong kind of approver all refuse it. The model never approves anything;
 * approvals come from an authenticated customer or staff member (E12).
 */

/** Who may approve an action. Staff-only actions cannot be approved by customers, and back. */
export type ApproverKind = 'customer' | 'staff';

export interface ApprovableQuote {
  state: QuoteState;
  hash: string;
  /** Cart revision the quote was priced from. */
  cartRevision: number;
  /** The cart's revision now; a later edit invalidates the quote. */
  currentCartRevision: number;
  /** The customer the quote was prepared for. */
  principalId: string;
  expiresAt: Date;
  approver: ApproverKind;
  merchantActive: boolean;
}

export interface ApprovalAttempt {
  kind: ApproverKind;
  /** The approving customer (for customer approvals). */
  principalId: string | null;
  quoteHash: string;
  cartRevision: number;
  now: Date;
}

export type ApprovalRefusal =
  | 'not_ready'
  | 'expired'
  | 'hash_mismatch'
  | 'cart_changed'
  | 'wrong_customer'
  | 'staff_only'
  | 'customer_only'
  | 'merchant_inactive';

export type ApprovalCheck = { ok: true } | { ok: false; reason: ApprovalRefusal };

export function checkQuoteApproval(
  quote: ApprovableQuote,
  attempt: ApprovalAttempt,
): ApprovalCheck {
  const refuse = (reason: ApprovalRefusal): ApprovalCheck => ({ ok: false, reason });
  // Who is asking comes first: a staff member cannot learn a customer's quote state by trying.
  if (quote.approver === 'staff' && attempt.kind === 'customer') return refuse('staff_only');
  if (quote.approver === 'customer' && attempt.kind === 'staff') return refuse('customer_only');
  if (attempt.kind === 'customer' && attempt.principalId !== quote.principalId) {
    return refuse('wrong_customer');
  }
  if (!quote.merchantActive) return refuse('merchant_inactive');
  if (quote.state === 'expired' || attempt.now.getTime() >= quote.expiresAt.getTime()) {
    return refuse('expired');
  }
  if (quote.state !== 'ready') return refuse('not_ready');
  if (
    attempt.cartRevision !== quote.cartRevision ||
    quote.currentCartRevision !== quote.cartRevision
  ) {
    return refuse('cart_changed');
  }
  if (attempt.quoteHash !== quote.hash) return refuse('hash_mismatch');
  return { ok: true };
}

/** When a quote stops being approvable, given the merchant's own validity and a ceiling. */
export function quoteExpiry(now: Date, merchantValidUntil: Date | null, maxMinutes: number): Date {
  const ceiling = new Date(now.getTime() + maxMinutes * 60_000);
  return merchantValidUntil && merchantValidUntil < ceiling ? merchantValidUntil : ceiling;
}
