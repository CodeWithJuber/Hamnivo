import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';

/**
 * Canonical hashing (RFC 8785 JSON canonicalization, then SHA-256). The same document gives the
 * same hash in the gateway, the widget and tests, so an approval can be bound to exactly what the
 * customer saw. Bigints become decimal strings first; `undefined` members are dropped as in JSON.
 */

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) out[key] = normalize(member);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Only finite numbers can be hashed');
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const text = canonicalize(normalize(value));
  if (text === undefined) throw new TypeError('Value cannot be canonicalized');
  return text;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** SHA-256 (hex) of the canonical JSON of a document. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
