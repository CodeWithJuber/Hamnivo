import type { CacheStore } from './store.js';

/**
 * Coalesces concurrent work for the same key in this process (K08): the first caller computes and
 * everyone else waiting on that key shares its result or its error. Nothing is remembered after
 * the work settles; caching the result is the caller's decision.
 */
export function createSingleflight() {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, compute: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) return existing as Promise<T>;
      const work = compute().finally(() => inflight.delete(key));
      inflight.set(key, work);
      return work;
    },
    get size() {
      return inflight.size;
    },
  };
}

export interface CoalesceOptions<T> {
  store: CacheStore;
  /** The lock key, for example the entry key plus `:lock`. */
  lockKey: string;
  /** How long a lock holder may compute before others give up waiting. */
  lockTtlMs: number;
  /** How long a caller waits for another process's result before computing itself. */
  waitMs: number;
  /** Reads the result another process stored, or null. */
  read: () => Promise<T | null>;
  compute: () => Promise<T>;
  pollMs?: number;
}

/**
 * Coalesces misses across processes with a short lock (K08). The holder computes. Others poll for
 * its result for at most `waitMs`, then compute themselves, so a slow or crashed holder delays a
 * caller by a bounded time and never blocks it. A store that cannot lock (outage) lets everyone
 * compute.
 */
export async function coalesce<T>(options: CoalesceOptions<T>): Promise<T> {
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const locked = await options.store.setIfAbsent(options.lockKey, token, options.lockTtlMs);
  if (locked) {
    try {
      return await options.compute();
    } finally {
      await options.store.delete([options.lockKey]);
    }
  }
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + options.waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const ready = await options.read();
    if (ready !== null) return ready;
  }
  return options.compute();
}
