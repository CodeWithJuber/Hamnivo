import { createHmac, hkdfSync } from 'node:crypto';
import { comparableValue } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

const INFO = 'hamnivo:memory-fingerprint:v1';

/**
 * Keyed fingerprints of memory values for deletion tombstones (L05). A tombstone must recognise a
 * deleted value without keeping it, and a plain hash of a short value ("Urdu") could be guessed,
 * so the fingerprint is an HMAC with a key derived from the key-encryption key, per tenant and
 * customer. Every available key version is tried, so fingerprints survive key rotation.
 */
@Injectable()
export class MemoryFingerprints {
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

  private compute(key: Buffer, tenantId: string, subjectId: string, value: string): string {
    return createHmac('sha256', key)
      .update(`${tenantId}\u0000${subjectId}\u0000${comparableValue(value)}`)
      .digest('hex');
  }

  /** The fingerprint stored in a new tombstone. */
  current(tenantId: string, subjectId: string, value: string): string {
    const key = this.keys.get(this.version);
    if (!key) throw new Error('The current key-encryption key is not loaded');
    return `${this.version}:${this.compute(key, tenantId, subjectId, value)}`;
  }

  /** Fingerprints of a value under every available key version, to compare with tombstones. */
  all(tenantId: string, subjectId: string, value: string): string[] {
    return [...this.keys].map(
      ([version, key]) => `${version}:${this.compute(key, tenantId, subjectId, value)}`,
    );
  }
}
