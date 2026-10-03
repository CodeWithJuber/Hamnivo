/**
 * Privacy rules for product analytics (O04). Reports hold aggregates only, never message content,
 * and a small group is not shown: a count from 1 to k-1, or an average or median over fewer than
 * k values, could point at one customer or one colleague. Zero is shown, because "nothing" is
 * different from "a few". When the total of a breakdown is shown, hiding a single row is not
 * enough (it equals the total minus the others), so the next smallest row is hidden with it.
 */

export const DEFAULT_MIN_GROUP_SIZE = 5;

/** A count, or null when it is too small to show. */
export function protectCount(count: number, k = DEFAULT_MIN_GROUP_SIZE): number | null {
  if (count <= 0) return 0;
  return count < k ? null : count;
}

export interface Protected {
  /** Hidden because the group is small, or to keep another small group from being derived. */
  suppressed: boolean;
}

/**
 * Hides small groups of a breakdown. With `totalShown`, a single hidden group is joined by the
 * next smallest visible one so it cannot be worked out from the total.
 */
export function protectBreakdown<T extends { count: number }>(
  groups: readonly T[],
  options: { k?: number; totalShown: boolean },
): (T & Protected)[] {
  const k = options.k ?? DEFAULT_MIN_GROUP_SIZE;
  const result = groups.map((group) => ({
    ...group,
    suppressed: group.count > 0 && group.count < k,
  }));
  const hidden = result.filter((g) => g.suppressed);
  if (options.totalShown && hidden.length === 1) {
    const next = result
      .filter((g) => !g.suppressed && g.count > 0)
      .sort((a, b) => a.count - b.count)[0];
    if (next) next.suppressed = true;
  }
  return result;
}

/** numerator / denominator, or null when the denominator is too small to publish a share. */
export function protectedRate(
  numerator: number,
  denominator: number,
  k = DEFAULT_MIN_GROUP_SIZE,
): number | null {
  if (denominator < k || denominator <= 0) return null;
  return numerator / denominator;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

export function protectedMedian(
  values: readonly number[],
  k = DEFAULT_MIN_GROUP_SIZE,
): number | null {
  return values.length < k ? null : median(values);
}

export function protectedAverage(
  values: readonly number[],
  k = DEFAULT_MIN_GROUP_SIZE,
): number | null {
  if (values.length < k || values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
