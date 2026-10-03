import type { SubscriptionState } from '@hamnivo/adapters/billing';
import type { SubscriptionStatus } from '@hamnivo/db/schema';

/**
 * What a subscription's state means for a workspace's plan (A16). Pure, so every case is tested:
 *
 * - trialing or active: the subscribed plan; a failed payment is forgotten once paid.
 * - past_due: the plan stays during the grace period that started with the first failed payment
 *   (BILLING_GRACE_DAYS), then the workspace falls back to the free plan.
 * - unpaid, canceled or paused: the free plan.
 * - incomplete (the first payment is still being made): nothing changes.
 */

export interface AccountState {
  subscriptionStatus: SubscriptionStatus;
  planKey: string | null;
  paymentFailedAt: Date | null;
  graceEndsAt: Date | null;
}

export type EntitlementAction = 'plan' | 'keep' | 'fallback';

export interface Next {
  account: AccountState;
  entitlement: EntitlementAction;
}

const DAY_MS = 86_400_000;

/**
 * The grace period of the current dunning cycle: it starts with the first failed payment. Once it
 * is over, `graceEndsAt` reads null (the worker or the event at hand moves the plan to free).
 */
function graceFrom(account: AccountState, failedAt: Date, now: Date, graceDays: number) {
  const paymentFailedAt = account.paymentFailedAt ?? failedAt;
  const ends = account.graceEndsAt ?? new Date(paymentFailedAt.getTime() + graceDays * DAY_MS);
  const over = ends <= now;
  return { paymentFailedAt, graceEndsAt: over ? null : ends, over };
}

/** The account and plan after the provider reported the subscription in this state. */
export function afterSubscription(
  account: AccountState,
  subscription: { state: SubscriptionState; planKey: string | null },
  now: Date,
  graceDays: number,
): Next {
  const planKey = subscription.planKey ?? account.planKey;
  switch (subscription.state) {
    case 'trialing':
    case 'active':
      return {
        account: {
          subscriptionStatus: subscription.state,
          planKey,
          paymentFailedAt: null,
          graceEndsAt: null,
        },
        entitlement: planKey ? 'plan' : 'keep',
      };
    case 'past_due': {
      const { over, ...grace } = graceFrom(account, now, now, graceDays);
      return {
        account: { subscriptionStatus: 'past_due', planKey, ...grace },
        entitlement: over ? 'fallback' : planKey ? 'plan' : 'keep',
      };
    }
    case 'unpaid':
    case 'canceled':
    case 'paused':
      return {
        account: {
          subscriptionStatus: subscription.state,
          planKey,
          paymentFailedAt: account.paymentFailedAt,
          graceEndsAt: null,
        },
        entitlement: 'fallback',
      };
    case 'incomplete':
      return {
        account: { ...account, subscriptionStatus: 'incomplete', planKey },
        entitlement: 'keep',
      };
  }
}

/** A payment failed: the grace period starts (once per dunning cycle); the plan is unchanged. */
export function afterPaymentFailure(
  account: AccountState,
  failedAt: Date,
  now: Date,
  graceDays: number,
): AccountState {
  const { over: _over, ...grace } = graceFrom(account, failedAt, now, graceDays);
  return { ...account, ...grace };
}

/** An invoice was paid: the dunning cycle is over. */
export function afterPayment(account: AccountState): AccountState {
  return { ...account, paymentFailedAt: null, graceEndsAt: null };
}

/** Whether the grace period is over for a workspace still past due (the worker's check). */
export function graceOver(account: AccountState, now: Date): boolean {
  return (
    account.subscriptionStatus === 'past_due' &&
    account.graceEndsAt !== null &&
    account.graceEndsAt <= now
  );
}
