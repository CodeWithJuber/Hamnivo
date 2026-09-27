/**
 * What the Hamnivo gateway accepts, so that input it would refuse fails here with a clear message
 * instead of as a rejected assertion in the customer's browser. The tests check these rules against
 * the gateway's contract (`@hamnivo/contracts`) and a copy of its key registration checks.
 */

/** Signature algorithms Hamnivo accepts for identity assertions. */
export type IdentityKeyAlg = 'ES256' | 'EdDSA' | 'RS256' | 'HS256';
/** Algorithms that sign with a private key; Hamnivo stores only the public key. */
export type PublicKeyAlg = Exclude<IdentityKeyAlg, 'HS256'>;

export const ALGORITHMS: readonly string[] = ['ES256', 'EdDSA', 'RS256', 'HS256'];

/** The key type (and curve) each algorithm needs. */
export const KEY_TYPES: Record<PublicKeyAlg, { kty: string; crv?: string; label: string }> = {
  ES256: { kty: 'EC', crv: 'P-256', label: 'an EC P-256' },
  EdDSA: { kty: 'OKP', crv: 'Ed25519', label: 'an Ed25519' },
  RS256: { kty: 'RSA', label: 'an RSA' },
};

/** Members of a public JWK, per key type. The gateway refuses other members, apart from labels. */
export const PUBLIC_MEMBERS: Record<string, readonly string[]> = {
  EC: ['kty', 'crv', 'x', 'y'],
  OKP: ['kty', 'crv', 'x'],
  RSA: ['kty', 'n', 'e'],
};

/** Members that only private or secret keys have. */
export const PRIVATE_MEMBERS: readonly string[] = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** Key ids the gateway accepts when a key is registered. */
export const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_NAME_LENGTH = 120;

/** The pattern of Zod 4's `z.email()`, which the gateway's claims contract uses. */
export const EMAIL_PATTERN =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export const DEFAULT_TTL_SECONDS = 120;
/** The gateway refuses assertions valid for longer than five minutes. */
export const MAX_TTL_SECONDS = 300;
/** Shorter lifetimes expire before the chat can use them (see CLOCK_ALLOWANCE_SECONDS). */
export const MIN_TTL_SECONDS = 10;
