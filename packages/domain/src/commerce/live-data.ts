/**
 * Sensitive and live-data exclusions (K06). Prices, stock, order, payment and refund state and
 * approvals are read from their authority every time; no answer cache may serve them, and a
 * cached answer that depended on one of them is not reusable. Catalog snapshots are evidence of
 * what the merchant said at a time (shown with that time), never a source for a price to charge.
 */

export const LIVE_DATA_CLASSES = [
  'commerce.price',
  'commerce.stock',
  'commerce.quote',
  'commerce.order_status',
  'commerce.payment_status',
  'commerce.refund_status',
  'commerce.approval',
] as const;

export type LiveDataClass = (typeof LIVE_DATA_CLASSES)[number];

const LIVE = new Set<string>(LIVE_DATA_CLASSES);

export function isLiveData(dataClass: string): boolean {
  return LIVE.has(dataClass) || dataClass.startsWith('commerce.');
}

export type CacheDecision =
  | { cacheable: true }
  | { cacheable: false; reason: 'live_commerce_data'; classes: string[] };

/**
 * Whether an answer built from these data classes may be stored or reused by any cache. Any
 * commerce class makes it uncacheable, including classes added later under `commerce.`.
 */
export function answerCacheDecision(dataClasses: readonly string[]): CacheDecision {
  const live = dataClasses.filter(isLiveData);
  return live.length
    ? { cacheable: false, reason: 'live_commerce_data', classes: live }
    : { cacheable: true };
}

/** HTTP caching for every commerce response: never stored by browsers or proxies. */
export const LIVE_DATA_CACHE_CONTROL = 'no-store';
