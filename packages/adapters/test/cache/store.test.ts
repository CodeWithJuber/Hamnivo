import { describe, expect, it, vi } from 'vitest';
import {
  type CacheFailure,
  type CacheStore,
  coalesce,
  createMemoryCacheStore,
  createSingleflight,
  createValkeyCacheStore,
  failOpen,
  type ValkeyCommands,
} from '../../src/cache/index.js';

/** Valkey semantics (PX expiry, NX, DEL counts) over a map and a controllable clock. */
function fakeValkey(clock: () => number): ValkeyCommands & { keys(): string[] } {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt <= clock()) data.delete(key);
    return data.get(key);
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlMs, onlyIfAbsent) {
      if (onlyIfAbsent && live(key)) return false;
      data.set(key, { value, expiresAt: clock() + ttlMs });
      return true;
    },
    async del(keys) {
      let count = 0;
      for (const key of keys) if (live(key) && data.delete(key)) count += 1;
      return count;
    },
    keys: () => [...data.keys()],
  };
}

function contract(name: string, make: (clock: () => number) => CacheStore) {
  describe(`${name} store`, () => {
    it('stores, reads and expires values', async () => {
      let now = 1_000;
      const store = make(() => now);
      expect(await store.get('a')).toBeNull();
      await store.set('a', 'one', 500);
      expect(await store.get('a')).toBe('one');
      now += 499;
      expect(await store.get('a')).toBe('one');
      now += 1;
      expect(await store.get('a')).toBeNull();
    });

    it('sets only when absent, and again after expiry', async () => {
      let now = 0;
      const store = make(() => now);
      expect(await store.setIfAbsent('lock', 'x', 100)).toBe(true);
      expect(await store.setIfAbsent('lock', 'y', 100)).toBe(false);
      expect(await store.get('lock')).toBe('x');
      now += 100;
      expect(await store.setIfAbsent('lock', 'z', 100)).toBe(true);
    });

    it('deletes keys and counts those that existed', async () => {
      const store = make(() => 0);
      await store.set('a', '1', 1000);
      await store.set('b', '2', 1000);
      expect(await store.delete(['a', 'b', 'missing'])).toBe(2);
      expect(await store.delete([])).toBe(0);
      expect(await store.get('a')).toBeNull();
    });

    it('rejects a TTL below one millisecond', async () => {
      const store = make(() => 0);
      await expect(store.set('a', '1', 0)).rejects.toThrow(RangeError);
    });
  });
}

contract('memory', (clock) => createMemoryCacheStore({ clock }));
contract('valkey', (clock) =>
  createValkeyCacheStore({ commands: fakeValkey(clock), prefix: 'hv:test:' }),
);

describe('valkey store', () => {
  it('keeps each prefix apart on the same server', async () => {
    const commands = fakeValkey(() => 0);
    const a = createValkeyCacheStore({ commands, prefix: 'hv:a:' });
    const b = createValkeyCacheStore({ commands, prefix: 'hv:b:' });
    await a.set('key', 'from-a', 1000);
    expect(await b.get('key')).toBeNull();
    expect(commands.keys()).toEqual(['hv:a:key']);
  });

  it('refuses an unsafe prefix', () => {
    expect(() => createValkeyCacheStore({ commands: fakeValkey(() => 0), prefix: '' })).toThrow();
    expect(() =>
      createValkeyCacheStore({ commands: fakeValkey(() => 0), prefix: 'has space' }),
    ).toThrow();
  });
});

describe('memory store', () => {
  it('drops the oldest entries beyond its bound', async () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    await store.set('a', '1', 1000);
    await store.set('b', '2', 1000);
    await store.set('c', '3', 1000);
    expect(store.size()).toBe(2);
    expect(await store.get('a')).toBeNull();
    expect(await store.get('c')).toBe('3');
  });
});

describe('failOpen (K08)', () => {
  const hanging: CacheStore = {
    kind: 'valkey',
    get: () => new Promise(() => undefined),
    set: () => new Promise(() => undefined),
    setIfAbsent: () => new Promise(() => undefined),
    delete: () => new Promise(() => undefined),
  };
  const broken: CacheStore = {
    kind: 'valkey',
    get: () => Promise.reject(new Error('ECONNREFUSED')),
    set: () => Promise.reject(new Error('ECONNREFUSED')),
    setIfAbsent: () => Promise.reject(new Error('ECONNREFUSED')),
    delete: () => Promise.reject(new Error('ECONNREFUSED')),
  };

  it('turns a hanging server into misses within the deadline', async () => {
    const failures: CacheFailure[] = [];
    const store = failOpen(hanging, { timeoutMs: 30, onFailure: (f) => failures.push(f) });
    const started = performance.now();
    expect(await store.get('k')).toBeNull();
    await store.set('k', 'v', 1000);
    expect(await store.setIfAbsent('k', 'v', 1000)).toBe(false);
    expect(await store.delete(['k'])).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(failures).toEqual([
      { operation: 'get', kind: 'timeout' },
      { operation: 'set', kind: 'timeout' },
      { operation: 'setIfAbsent', kind: 'timeout' },
      { operation: 'delete', kind: 'timeout' },
    ]);
  });

  it('turns connection errors into misses and reports them', async () => {
    const onFailure = vi.fn();
    const store = failOpen(broken, { timeoutMs: 50, onFailure });
    expect(await store.get('k')).toBeNull();
    expect(onFailure).toHaveBeenCalledWith({ operation: 'get', kind: 'error' });
  });

  it('passes values through when the store works', async () => {
    const store = failOpen(createMemoryCacheStore(), { timeoutMs: 50 });
    await store.set('k', 'v', 1000);
    expect(await store.get('k')).toBe('v');
  });
});

describe('singleflight (K08)', () => {
  it('computes once for concurrent callers of one key', async () => {
    const flight = createSingleflight();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'value';
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => flight.run('k', compute)));
    expect(results).toEqual(Array(10).fill('value'));
    expect(calls).toBe(1);
    expect(flight.size).toBe(0);
    await flight.run('k', compute);
    expect(calls).toBe(2);
  });

  it('shares an error and lets the next call try again', async () => {
    const flight = createSingleflight();
    const failing = () => Promise.reject(new Error('model down'));
    await expect(Promise.all([flight.run('k', failing), flight.run('k', failing)])).rejects.toThrow(
      'model down',
    );
    await expect(flight.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('coalesce (K08)', () => {
  it('lets one process compute while another waits for its result', async () => {
    const store = createMemoryCacheStore();
    const results = new Map<string, string>();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      results.set('k', 'value');
      return 'value';
    };
    const options = {
      store,
      lockKey: 'k:lock',
      lockTtlMs: 1000,
      waitMs: 1000,
      pollMs: 5,
      read: async () => results.get('k') ?? null,
      compute,
    };
    expect(await Promise.all([coalesce(options), coalesce(options)])).toEqual(['value', 'value']);
    expect(calls).toBe(1);
    expect(await store.get('k:lock')).toBeNull();
  });

  it('computes after a bounded wait when the lock holder never delivers', async () => {
    const store = createMemoryCacheStore();
    await store.set('k:lock', 'crashed-holder', 10_000);
    const started = performance.now();
    const value = await coalesce({
      store,
      lockKey: 'k:lock',
      lockTtlMs: 1000,
      waitMs: 60,
      pollMs: 10,
      read: async () => null,
      compute: async () => 'fresh',
    });
    expect(value).toBe('fresh');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
