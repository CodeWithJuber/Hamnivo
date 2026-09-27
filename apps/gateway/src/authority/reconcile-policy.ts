import type { OwnerMode } from '@hamnivo/db/schema';

/** Seconds between polls right after something changed in a conversation. */
export const RECONCILE_MIN_SECONDS = 15;
/** Ceiling of the backoff while Chatwoot cannot be read. */
export const RECONCILE_ERROR_MAX_SECONDS = 300;
/** A resolved conversation is no longer followed after this long without activity. */
export const RECONCILE_FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest wait between polls of a conversation in this state. */
export function reconcileCeiling(status: string, ownerMode: OwnerMode): number {
  if (status === 'resolved') return 3600;
  if (status === 'snoozed') return 600;
  return ownerMode === 'HUMAN_ACTIVE' ? 120 : 60;
}

/** Back to the minimum after a change; otherwise the wait doubles, up to the ceiling. */
export function nextReconcileInterval(previous: number, changed: boolean, ceiling: number): number {
  if (changed) return RECONCILE_MIN_SECONDS;
  return Math.min(Math.max(previous, RECONCILE_MIN_SECONDS) * 2, ceiling);
}
