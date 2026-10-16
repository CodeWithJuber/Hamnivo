import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

const INFO = 'hamnivo:identity-fingerprint:v1';

/** What identified an erased customer, fingerprinted on its own so each can be recognised. */
export type IdentityKind = 'subject' | 'email' | 'phone' | 'handle' | 'identifier';

/** The same person written differently is the same value: case, spaces and phone punctuation. */
function comparable(kind: IdentityKind, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (kind === 'phone') return trimmed.replace(/[^\d+]/g, '');
  return trimmed;
}

/**
 * Keyed fingerprints of what identified an erased customer (A10): their ID in the business's
 * systems, email, phone, channel handle and chat engine identifier. An erasure tombstone keeps
 * them so a restored backup or a later import recognises the person without the tombstone saying
 * who they were. HMACs with a key derived from the key-encryption key, per workspace and brand,
 * under every available key version so they survive key rotation.
 */
@Injectable()
export class IdentityFingerprints {
  private readonly keys: Map<number, Buffer>;
  private readonly version: number;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.version = config.kek.version;
    const rings = new Map<number, Buffer>([
      ...config.kek.retired,
      [config.kek.version, config.kek.key],
    ]);
    this.keys = new Map(
      [...rings].map(([version, kek]) => [
        version,
        Buffer.from(hkdfSync('sha256', kek, Buffer.from('hamnivo'), Buffer.from(INFO), 32)),
      ]),
    );
  }

  private compute(key: Buffer, scope: Scope, kind: IdentityKind, value: string): string {
    return createHmac('sha256', key)
      .update(
        `${scope.tenantId}\u0000${scope.brandId}\u0000${kind}\u0000${comparable(kind, value)}`,
      )
      .digest('hex');
  }

  /** The fingerprints stored in a new tombstone: one per value given, empty values skipped. */
  current(scope: Scope, values: Partial<Record<IdentityKind, string | null>>): string[] {
    const key = this.keys.get(this.version);
    if (!key) throw new Error('The current key-encryption key is not loaded');
    return Object.entries(values)
      .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
      .map(
        ([kind, value]) =>
          `${this.version}:${this.compute(key, scope, kind as IdentityKind, value as string)}`,
      );
  }

  /** Fingerprints of the values under every key version, to compare with tombstones. */
  all(scope: Scope, values: Partial<Record<IdentityKind, string | null>>): string[] {
    return [...this.keys].flatMap(([version, key]) =>
      Object.entries(values)
        .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
        .map(
          ([kind, value]) =>
            `${version}:${this.compute(key, scope, kind as IdentityKind, value as string)}`,
        ),
    );
  }
}

interface Scope {
  tenantId: string;
  brandId: string;
}
