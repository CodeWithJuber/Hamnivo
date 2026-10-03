/** Where the SDK keeps its refresh token and unsent messages (localStorage in browsers). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** Browser storage when available and usable (private modes may throw), memory otherwise. */
export function defaultStorage(): KeyValueStorage {
  try {
    const storage = globalThis.localStorage;
    const probe = '__hamnivo_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return new MemoryStorage();
  }
}

/**
 * The same storage under its own names: every key gets a prefix, so what it keeps (the session,
 * unsent messages, drafts) never meets what the same device keeps without it. A test chat opened
 * in Studio uses this, so it never takes over or continues a real visitor's session.
 */
export function prefixedStorage(storage: KeyValueStorage, prefix: string): KeyValueStorage {
  return {
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => storage.removeItem(`${prefix}${key}`),
  };
}
