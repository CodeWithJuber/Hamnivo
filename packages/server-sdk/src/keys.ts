import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { invalid, isObject } from './errors.js';
import {
  KEY_TYPES,
  KID_PATTERN,
  PRIVATE_MEMBERS,
  PUBLIC_MEMBERS,
  type PublicKeyAlg,
} from './rules.js';

/** A new key pair for identity assertions: register `publicJwk`, keep `privateJwk` secret. */
export interface GeneratedIdentityKey {
  /** The key's RFC 7638 thumbprint. Register the public key under it, then sign with it. */
  kid: string;
  alg: PublicKeyAlg;
  /** Keep it on your server only, for example in a secret store. */
  privateJwk: JWK;
  /** Public members only, ready for `identityKeyRequest`. */
  publicJwk: JWK;
}

/** Body of `POST /v1/admin/brands/{brandId}/identity-keys` for a public key. */
export interface IdentityKeyRequest {
  alg: PublicKeyAlg;
  publicJwk: JWK;
  /** When left out, Hamnivo picks a key id and returns it. */
  kid?: string;
}

/**
 * Makes a key pair for signing identity assertions: ES256 by default, or EdDSA or RS256 (2048
 * bits). HS256 secrets are made by Hamnivo when you register an HS256 key.
 */
export async function generateIdentityKey(
  alg: PublicKeyAlg = 'ES256',
): Promise<GeneratedIdentityKey> {
  if ((alg as string) === 'HS256') {
    throw invalid(
      'Hamnivo makes HS256 secrets itself. Register { "alg": "HS256" } and keep the secret it shows once.',
    );
  }
  if (!Object.hasOwn(KEY_TYPES, alg)) throw invalid('alg must be ES256, EdDSA or RS256.');
  const { privateKey } = await generateKeyPair(alg, { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = publicMembers(privateJwk);
  return { kid: await calculateJwkThumbprint(publicJwk), alg, privateJwk, publicJwk };
}

/**
 * The request body that registers a public key with Hamnivo. It keeps the public members only, as
 * Hamnivo stores them, and refuses a private key so that one is never sent by mistake.
 */
export function identityKeyRequest(publicJwk: JWK, kid?: string): IdentityKeyRequest {
  if (!isObject(publicJwk)) throw invalid('publicJwk must be a JWK object.');
  const alg = algorithmFor(publicJwk);
  if (PRIVATE_MEMBERS.some((member) => Object.hasOwn(publicJwk, member))) {
    throw invalid(
      'publicJwk is a private key. Register the public key only, and keep the private key secret.',
    );
  }
  if (publicJwk.alg !== undefined && publicJwk.alg !== alg) {
    throw invalid(`publicJwk is marked for another algorithm. Hamnivo uses ${alg} for this key.`);
  }
  const clean = publicMembers(publicJwk);
  const values = Object.values(clean);
  if (values.some((value) => typeof value !== 'string' || value === '')) {
    throw invalid('publicJwk is incomplete.');
  }
  if (alg === 'RS256' && modulusBytes(clean.n as string) < 256) {
    throw invalid('RSA keys need at least 2048 bits.');
  }
  if (kid === undefined) return { alg, publicJwk: clean };
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
    throw invalid('kid must be 1 to 64 letters, digits, dots, underscores or dashes.');
  }
  return { alg, publicJwk: clean, kid };
}

function algorithmFor(jwk: JWK): PublicKeyAlg {
  for (const [alg, expected] of Object.entries(KEY_TYPES)) {
    if (jwk.kty === expected.kty && (expected.crv === undefined || jwk.crv === expected.crv)) {
      return alg as PublicKeyAlg;
    }
  }
  if (jwk.kty === 'oct') {
    throw invalid(
      'This is a secret key. For HS256, register { "alg": "HS256" } and Hamnivo makes the secret.',
    );
  }
  throw invalid('Hamnivo accepts EC P-256 (ES256), Ed25519 (EdDSA) and RSA (RS256) keys.');
}

function publicMembers(jwk: JWK): JWK {
  const members = PUBLIC_MEMBERS[jwk.kty as string] ?? [];
  return Object.fromEntries(members.map((m) => [m, (jwk as Record<string, unknown>)[m]])) as JWK;
}

function modulusBytes(n: string): number {
  try {
    return base64url.decode(n).length;
  } catch {
    throw invalid('publicJwk has an unreadable modulus (n).');
  }
}
