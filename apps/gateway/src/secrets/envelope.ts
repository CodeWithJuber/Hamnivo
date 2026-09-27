import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for stored secrets (A06, X04). Each value gets its own 256-bit data key
 * (AES-256-GCM, 96-bit IV); the data key is wrapped with the key-encryption key (KEK). The
 * additional authenticated data binds a ciphertext to its tenant and row, so swapping ciphertexts
 * between rows or tenants fails authentication. Rotating the KEK only rewraps data keys.
 */

export interface KeyRing {
  version: number;
  key: Buffer;
  retired: ReadonlyMap<number, Buffer>;
}

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  wrappedKey: Buffer;
  kekVersion: number;
}

const WRAP_AAD = Buffer.from('hamnivo:dek:v1');

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; payload: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const payload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, payload };
}

function gcmDecrypt(key: Buffer, iv: Buffer, payload: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([
    decipher.update(payload.subarray(0, payload.length - 16)),
    decipher.final(),
  ]);
}

function kekFor(ring: KeyRing, version: number): Buffer {
  if (version === ring.version) return ring.key;
  const retired = ring.retired.get(version);
  if (!retired) throw new Error(`Key-encryption key version ${version} is not available`);
  return retired;
}

function wrap(ring: KeyRing, dek: Buffer): Buffer {
  const { iv, payload } = gcmEncrypt(ring.key, dek, WRAP_AAD);
  return Buffer.concat([iv, payload]);
}

function unwrap(ring: KeyRing, wrapped: Buffer, version: number): Buffer {
  return gcmDecrypt(kekFor(ring, version), wrapped.subarray(0, 12), wrapped.subarray(12), WRAP_AAD);
}

export function secretAad(tenantId: string, secretId: string): Buffer {
  return Buffer.from(`hamnivo:secret:v1:${tenantId}:${secretId}`);
}

export function seal(ring: KeyRing, plaintext: string, aad: Buffer): Sealed {
  const dek = randomBytes(32);
  try {
    const { iv, payload } = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), aad);
    return { ciphertext: payload, iv, wrappedKey: wrap(ring, dek), kekVersion: ring.version };
  } finally {
    dek.fill(0);
  }
}

export function open(ring: KeyRing, sealed: Sealed, aad: Buffer): string {
  const dek = unwrap(ring, sealed.wrappedKey, sealed.kekVersion);
  try {
    return gcmDecrypt(dek, sealed.iv, sealed.ciphertext, aad).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the data key with the active KEK; the ciphertext itself is unchanged. */
export function rewrap(ring: KeyRing, sealed: Sealed): Sealed {
  if (sealed.kekVersion === ring.version) return sealed;
  const dek = unwrap(ring, sealed.wrappedKey, sealed.kekVersion);
  try {
    return { ...sealed, wrappedKey: wrap(ring, dek), kekVersion: ring.version };
  } finally {
    dek.fill(0);
  }
}

/** Last characters shown in lists, never more than four and never more than a quarter. */
export function hintOf(value: string): string {
  const visible = Math.min(4, Math.floor(value.length / 4));
  return visible > 0 ? value.slice(-visible) : '';
}
