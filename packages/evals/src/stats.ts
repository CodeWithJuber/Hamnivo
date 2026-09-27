/** A proportion with its 95% Wilson score interval, which stays honest for small slices. */
export interface Rate {
  successes: number;
  total: number;
  /** successes / total, or null when there is nothing to measure. */
  rate: number | null;
  low: number | null;
  high: number | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function wilson(successes: number, total: number, z = 1.96): Rate {
  if (total === 0) return { successes, total, rate: null, low: null, high: null };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    successes,
    total,
    rate: round(p),
    low: round(Math.max(0, center - half)),
    high: round(Math.min(1, center + half)),
  };
}

/** "0.917 (0.646–0.985, 11/12)" for reports; "n/a" when nothing was measured. */
export function formatRate(rate: Rate): string {
  if (rate.rate === null) return 'n/a';
  return `${rate.rate.toFixed(3)} (${rate.low?.toFixed(3)}–${rate.high?.toFixed(3)}, ${rate.successes}/${rate.total})`;
}

/** Groups items by a key, keeping first-seen order. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}
