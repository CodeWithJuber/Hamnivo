import type { KeyValueStorage } from './storage.js';

/** Longest draft kept on the device; the composer allows no more. */
const MAX_DRAFT = 10_000;

/**
 * What the visitor typed but did not send (W07), kept on this device across reloads, per person
 * and conversation (`scope`), so a draft never shows up for someone else. Signing out forgets all
 * of them.
 */
export class Drafts {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string,
  ) {}

  private get indexKey() {
    return `${this.prefix}:drafts`;
  }

  private key(scope: string) {
    return `${this.prefix}:draft:${scope}`;
  }

  private scopes(): string[] {
    try {
      const scopes = JSON.parse(this.storage.getItem(this.indexKey) ?? '[]');
      return Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  private track(scope: string, stored: boolean) {
    const scopes = new Set(this.scopes());
    if (stored === scopes.has(scope)) return;
    if (stored) scopes.add(scope);
    else scopes.delete(scope);
    try {
      if (scopes.size) this.storage.setItem(this.indexKey, JSON.stringify([...scopes]));
      else this.storage.removeItem(this.indexKey);
    } catch {
      // Storage full or blocked: the draft simply is not kept.
    }
  }

  get(scope: string): string {
    try {
      return this.storage.getItem(this.key(scope)) ?? '';
    } catch {
      return '';
    }
  }

  /** Keeps the text; an empty text forgets the draft. */
  set(scope: string, text: string): void {
    const kept = text.trim() ? text.slice(0, MAX_DRAFT) : '';
    try {
      if (kept) this.storage.setItem(this.key(scope), kept);
      else this.storage.removeItem(this.key(scope));
      this.track(scope, Boolean(kept));
    } catch {
      // Storage full or blocked: the draft simply is not kept.
    }
  }

  clear(scope: string): void {
    this.set(scope, '');
  }

  /** Forgets every draft on this device (sign-out). */
  clearAll(): void {
    for (const scope of this.scopes()) {
      try {
        this.storage.removeItem(this.key(scope));
      } catch {
        // Nothing more to do.
      }
    }
    try {
      this.storage.removeItem(this.indexKey);
    } catch {
      // Nothing more to do.
    }
  }
}
