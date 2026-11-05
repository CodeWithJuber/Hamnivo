/**
 * Retention (A10): how long a workspace keeps resolved conversations. Keeping things longer, or
 * forever, takes effect at once; deleting sooner waits a grace period first, so a mistake can be
 * undone before anything is deleted. Saving the period in force again is that undo.
 */

/** Turning retention on or shortening it waits this many days before anything is deleted. */
export const RETENTION_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

export interface RetentionState {
  /** Days a resolved conversation is kept after its last activity; null keeps everything. */
  conversationDays: number | null;
  /** A shorter period waiting out its grace, and when it takes effect. */
  pendingDays: number | null;
  pendingFrom: Date | null;
}

/** The policy in force at `now`: a waiting change whose grace has ended has taken effect. */
export function effectiveRetention(state: RetentionState, now: Date): RetentionState {
  if (state.pendingDays !== null && state.pendingFrom && state.pendingFrom <= now) {
    return { conversationDays: state.pendingDays, pendingDays: null, pendingFrom: null };
  }
  return state;
}

/** What saving `next` makes of the policy. */
export function planRetention(
  current: RetentionState,
  next: number | null,
  now: Date,
): RetentionState {
  const live = effectiveRetention(current, now);
  const settled = { conversationDays: next, pendingDays: null, pendingFrom: null };
  // The period in force again: any waiting change is cancelled.
  if (next === live.conversationDays) return settled;
  // Keeping things longer, or forever, deletes nothing sooner.
  if (next === null || (live.conversationDays !== null && next > live.conversationDays)) {
    return settled;
  }
  // Saving the waiting change again does not restart its grace.
  if (live.pendingDays === next) return live;
  return {
    conversationDays: live.conversationDays,
    pendingDays: next,
    pendingFrom: new Date(now.getTime() + RETENTION_GRACE_DAYS * DAY_MS),
  };
}

/** Activity before this is old enough to delete under `days`. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
