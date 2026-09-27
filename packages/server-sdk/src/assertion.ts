import { base64url, type CryptoKey, type JWK, type KeyObject, SignJWT } from 'jose';
import { invalid, isObject } from './errors.js';
import {
  ALGORITHMS,
  DEFAULT_TTL_SECONDS,
  EMAIL_PATTERN,
  type IdentityKeyAlg,
  KEY_TYPES,
  KID_PATTERN,
  MAX_NAME_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  type PublicKeyAlg,
} from './rules.js';

/** The key that signs assertions, as registered for the brand in Hamnivo. */
export interface IdentitySigningKey {
  /** The key id registered with Hamnivo. It goes in the assertion's `kid` header. */
  kid: string;
  alg: IdentityKeyAlg;
  /** ES256, EdDSA and RS256: the private key whose public key you registered. */
  privateKey?: JWK | CryptoKey | KeyObject;
  /** HS256: the secret Hamnivo showed once when you registered the key, exactly as shown. */
  secret?: string;
}

/** The signed-in customer, taken from your own records. Never copy these from the request. */
export interface IdentityCustomer {
  /** Your stable id for this customer account, 1 to 200 characters. It becomes `sub`. */
  id: string;
  /** Name shown to staff, at most 120 characters. */
  name?: string | null;
  email?: string | null;
  /** True only when your website has confirmed the address. Hamnivo keeps the email only then. */
  emailVerified?: boolean | null;
}

export interface IdentityAssertionOptions {
  /** The brand's widget ID (`wid_…`). It becomes `aud`. */
  widgetId: string;
  key: IdentitySigningKey;
  customer: IdentityCustomer;
  /** Seconds from `iat` to `exp`: 120 by default, at most 300 (larger values are capped). */
  ttlSeconds?: number;
}

/**
 * The gateway refuses an assertion issued in the future, even by one second. Dating `iat` a few
 * seconds back keeps assertions valid when this server's clock runs slightly ahead of Hamnivo's.
 */
const CLOCK_ALLOWANCE_SECONDS = 5;
/** The gateway accepts each `jti` once per brand, so it must never repeat. */
const JTI_BYTES = 16;

/**
 * Signs a short-lived identity assertion (a compact JWS) for a signed-in customer. Send it to your
 * page, which passes it to `Hamnivo.identify(assertion)`. Sign a new one for every call: Hamnivo
 * accepts each assertion once.
 */
export async function createIdentityAssertion(options: IdentityAssertionOptions): Promise<string> {
  if (!isObject(options)) throw invalid('Pass { widgetId, key, customer }.');
  const { widgetId, key, customer, ttlSeconds = DEFAULT_TTL_SECONDS } = options;
  if (typeof widgetId !== 'string' || !widgetId.startsWith('wid_')) {
    throw invalid("widgetId must be the brand's widget ID, which starts with wid_.");
  }
  const signingKey = signingKeyFor(key);
  const { sub, ...profile } = customerClaims(customer);
  const ttl = lifetime(ttlSeconds);
  const iat = Math.floor(Date.now() / 1000) - CLOCK_ALLOWANCE_SECONDS;
  const jti = base64url.encode(crypto.getRandomValues(new Uint8Array(JTI_BYTES)));
  const payload = { sub, aud: widgetId, iat, exp: iat + ttl, jti, ...profile };
  try {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
      .sign(signingKey);
  } catch (error) {
    // Only the key can fail here; jose explains how (curve, key size, usage).
    const reason = error instanceof Error ? error.message : String(error);
    throw invalid(`key.privateKey cannot sign ${key.alg}: ${reason}`, error);
  }
}

function signingKeyFor(key: IdentitySigningKey): Uint8Array | JWK | CryptoKey | KeyObject {
  if (!isObject(key)) {
    throw invalid('key is required: { kid, alg, privateKey }, or { kid, alg: "HS256", secret }.');
  }
  const { kid, alg, privateKey, secret } = key;
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
    throw invalid(
      'key.kid must be the key id registered with Hamnivo: 1 to 64 letters, digits, dots, underscores or dashes.',
    );
  }
  if (!ALGORITHMS.includes(alg)) throw invalid('key.alg must be ES256, EdDSA, RS256 or HS256.');
  if (alg === 'HS256') {
    if (privateKey !== undefined) {
      throw invalid('HS256 signs with key.secret. key.privateKey is for ES256, EdDSA and RS256.');
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      throw invalid(
        'HS256 needs key.secret: the secret Hamnivo showed when you registered the key.',
      );
    }
    if (/\s/.test(secret)) {
      throw invalid(
        'key.secret contains spaces or line breaks. Use it exactly as Hamnivo showed it.',
      );
    }
    // The gateway uses the characters of the secret as the HMAC key. It is not base64-decoded.
    return new TextEncoder().encode(secret);
  }
  if (secret !== undefined) {
    throw invalid(`${alg} signs with key.privateKey. key.secret is for HS256 only.`);
  }
  if (privateKey === undefined || privateKey === null) {
    throw invalid(`${alg} needs key.privateKey: the private key whose public key you registered.`);
  }
  if (typeof privateKey === 'string') {
    throw invalid(
      'key.privateKey must be a JWK object, a CryptoKey or a KeyObject, not a string. Parse a JWK with JSON.parse, or load a PEM key with crypto.createPrivateKey.',
    );
  }
  if (!isObject(privateKey)) {
    throw invalid('key.privateKey must be a JWK object, a CryptoKey or a KeyObject.');
  }
  const tag = (privateKey as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  if (tag === 'CryptoKey' || tag === 'KeyObject') {
    const { type } = privateKey as { type?: unknown };
    if (type !== 'private') {
      throw invalid(`key.privateKey is a ${String(type)} key. Sign with the private key.`);
    }
    return privateKey;
  }
  checkPrivateJwk(alg, privateKey as JWK);
  return privateKey;
}

function checkPrivateJwk(alg: PublicKeyAlg, jwk: JWK): void {
  const expected = KEY_TYPES[alg];
  if (jwk.kty !== expected.kty || (expected.crv !== undefined && jwk.crv !== expected.crv)) {
    throw invalid(
      `${alg} needs ${expected.label} private key, and key.privateKey is another kind of key. Check that key.alg matches the key.`,
    );
  }
  if (typeof jwk.d !== 'string') {
    throw invalid('key.privateKey is a public key. Sign with the private key (the JWK with "d").');
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw invalid(`key.privateKey is marked for another algorithm than ${alg}.`);
  }
}

type CustomerClaims = { sub: string; name?: string; email?: string; email_verified?: boolean };

function customerClaims(customer: IdentityCustomer): CustomerClaims {
  if (!isObject(customer)) {
    throw invalid('customer is required: { id, name?, email?, emailVerified? }.');
  }
  const { id, name, email, emailVerified } = customer;
  if (typeof id !== 'string') {
    throw invalid('customer.id must be a string. Convert a number with String(id).');
  }
  if (id.trim() === '') {
    throw invalid('customer.id is empty. Use your stable id for this customer account.');
  }
  if (id.length > MAX_SUBJECT_LENGTH) {
    throw invalid(`customer.id is longer than ${MAX_SUBJECT_LENGTH} characters.`);
  }
  const claims: CustomerClaims = { sub: id };
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string') throw invalid('customer.name must be a string.');
    if (name.length > MAX_NAME_LENGTH) {
      throw invalid(`customer.name is longer than ${MAX_NAME_LENGTH} characters.`);
    }
    claims.name = name;
  }
  if (email !== undefined && email !== null) {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw invalid(
        'customer.email is not an address Hamnivo accepts. Correct it or leave it out.',
      );
    }
    claims.email = email;
  }
  if (emailVerified !== undefined && emailVerified !== null) {
    if (typeof emailVerified !== 'boolean') {
      throw invalid('customer.emailVerified must be true or false.');
    }
    claims.email_verified = emailVerified;
  }
  return claims;
}

function lifetime(ttlSeconds: unknown): number {
  if (
    typeof ttlSeconds !== 'number' ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS
  ) {
    throw invalid(`ttlSeconds must be a whole number of seconds, at least ${MIN_TTL_SECONDS}.`);
  }
  return Math.min(ttlSeconds, MAX_TTL_SECONDS);
}
