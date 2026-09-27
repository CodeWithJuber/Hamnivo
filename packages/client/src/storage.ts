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
