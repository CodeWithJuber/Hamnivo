/**
 * Cache storage behind one small interface (K12): Valkey in production, memory in tests and
 * development. Policy (what may be cached, under which key) lives in `@hamnivo/domain`; a store only
 * keeps opaque strings until they expire. A store never decides eligibility.
 */
export interface CacheStore {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Sets only when the key is absent (a short lock); true when this call set it. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes keys; resolves with how many existed. */
  delete(keys: readonly string[]): Promise<number>;
}

/**
 * The Valkey commands a store needs, so this package does not depend on a client library. The
 * gateway adapts its ioredis connection (`SET key value PX ttl [NX]`, `GET`, `DEL`).
 */
export interface ValkeyCommands {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ttlMs`, with `NX` when `onlyIfAbsent`; true when the value was set. */
  set(key: string, value: string, ttlMs: number, onlyIfAbsent: boolean): Promise<boolean>;
  del(keys: string[]): Promise<number>;
}

const positive = (ttlMs: number) => {
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be at least 1');
  return Math.ceil(ttlMs);
};

/**
 * A store on Valkey. Every key gets `prefix` first, so separate deployments and test runs never
 * see each other's entries.
 */
export function createValkeyCacheStore(options: {
  commands: ValkeyCommands;
  prefix: string;
}): CacheStore {
  const { commands, prefix } = options;
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(prefix)) {
    throw new TypeError('prefix must be 1 to 64 letters, digits, ":", "_" or "-"');
  }
  const full = (key: string) => `${prefix}${key}`;
  return {
    kind: 'valkey',
    get: (key) => commands.get(full(key)),
    async set(key, value, ttlMs) {
      await commands.set(full(key), value, positive(ttlMs), false);
    },
    setIfAbsent: (key, value, ttlMs) => commands.set(full(key), value, positive(ttlMs), true),
    delete: (keys) => (keys.length === 0 ? Promise.resolve(0) : commands.del(keys.map(full))),
  };
}

/** An in-process store for tests and development, bounded and with expiry. */
export function createMemoryCacheStore(
  options: { maxEntries?: number; clock?: () => number } = {},
): CacheStore & { size(): number } {
  const maxEntries = options.maxEntries ?? 10_000;
  const clock = options.clock ?? (() => Date.now());
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const put = (key: string, value: string, ttlMs: number) => {
    entries.delete(key);
    entries.set(key, { value, expiresAt: clock() + positive(ttlMs) });
    // Oldest first out when full (Map keeps insertion order).
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    kind: 'memory',
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlMs) {
      put(key, value, ttlMs);
    },
    async setIfAbsent(key, value, ttlMs) {
      if (live(key)) return false;
      put(key, value, ttlMs);
      return true;
    },
    async delete(keys) {
      let deleted = 0;
      for (const key of keys) {
        if (live(key)) deleted += 1;
        entries.delete(key);
      }
      return deleted;
    },
    size: () => entries.size,
  };
}

export type CacheOperation = 'get' | 'set' | 'setIfAbsent' | 'delete';

export interface CacheFailure {
  operation: CacheOperation;
  kind: 'timeout' | 'error';
}

class CacheTimeout extends Error {
  override readonly name = 'CacheTimeout';
}

function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CacheTimeout()), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Makes a store fail open (K08): every operation has a deadline, and a failure or timeout reads
 * as a miss (`get` → null, `setIfAbsent` → false, `delete` → 0) instead of an error. Callers then
 * compute fresh; a cache outage never blocks a reply or a human message. `onFailure` gets the
 * operation and kind for metrics, never the key or value.
 */
export function failOpen(
  store: CacheStore,
  options: { timeoutMs: number; onFailure?: (failure: CacheFailure) => void },
): CacheStore {
  const guard = async <T>(operation: CacheOperation, work: () => Promise<T>, fallback: T) => {
    try {
      return await within(work(), options.timeoutMs);
    } catch (error) {
      options.onFailure?.({ operation, kind: error instanceof CacheTimeout ? 'timeout' : 'error' });
      return fallback;
    }
  };
  return {
    kind: store.kind,
    get: (key) => guard('get', () => store.get(key), null),
    set: (key, value, ttlMs) => guard('set', () => store.set(key, value, ttlMs), undefined),
    setIfAbsent: (key, value, ttlMs) =>
      guard('setIfAbsent', () => store.setIfAbsent(key, value, ttlMs), false),
    delete: (keys) => guard('delete', () => store.delete(keys), 0),
  };
}
