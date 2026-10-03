import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyRing } from '../secrets/envelope.js';

/**
 * API keys look like `hv_live_8f3k2m1qa9bc_<43 characters>`: the part up to the second
 * underscore-separated group is the public prefix (stored, shown in lists, used to find the key);
 * the rest is the secret, shown once. Only an HMAC of the secret is stored, keyed with a key
 * derived from the key-encryption key, so a database copy alone cannot be used to check guesses.
 */

const PREFIX = 'hv_live_';
const KEY = /^(hv_live_[0-9a-hjkmnp-tv-z]{12})_([0-9A-Za-z]{40,64})$/;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const INFO = 'hamnivo:api-key:v1';

function encode(bytes: Buffer, alphabet: string, length: number): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  const base = BigInt(alphabet.length);
  let out = '';
  while (out.length < length) {
    out = alphabet[Number(value % base)] + out;
    value /= base;
  }
  return out;
}

export interface GeneratedKey {
  prefix: string;
  secret: string;
  /** The whole key, as given to the person once. */
  key: string;
}

export function generateApiKey(): GeneratedKey {
  const prefix = `${PREFIX}${encode(randomBytes(8), CROCKFORD, 12)}`;
  // 32 random bytes in 43 base-62 characters (256 bits).
  const secret = encode(randomBytes(32), BASE62, 43);
  return { prefix, secret, key: `${prefix}_${secret}` };
}

/** Splits a presented key; null when it is not shaped like a Hamnivo API key. */
export function parseApiKey(value: string): { prefix: string; secret: string } | null {
  const match = KEY.exec(value.trim());
  return match?.[1] && match[2] ? { prefix: match[1], secret: match[2] } : null;
}

/** Whether an Authorization header carries a Hamnivo API key (not a session or widget token). */
export function bearerApiKey(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(hv_live_\S+)$/i.exec(value ?? '');
  return match?.[1] ?? null;
}

/** HMAC keys per key-encryption-key version, so stored hashes survive KEK rotation. */
export class ApiKeyHasher {
  private readonly keys: Map<number, Buffer>;
  readonly version: number;

  constructor(ring: KeyRing) {
    this.version = ring.version;
    this.keys = new Map(
      [...ring.retired, [ring.version, ring.key] as const].map(([version, kek]) => [
        version,
        Buffer.from(hkdfSync('sha256', kek, Buffer.from('hamnivo'), Buffer.from(INFO), 32)),
      ]),
    );
  }

  hash(secret: string, version = this.version): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Key-encryption key version ${version} is not available`);
    return createHmac('sha256', key).update(secret, 'utf8').digest();
  }

  /** Constant-time comparison; false when the stored version's key is no longer available. */
  verify(secret: string, stored: Buffer, version: number): boolean {
    if (!this.keys.has(version)) return false;
    const computed = this.hash(secret, version);
    return computed.length === stored.length && timingSafeEqual(computed, stored);
  }
}
