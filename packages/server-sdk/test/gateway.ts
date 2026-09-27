/**
 * Test oracle: the gateway's own rules, copied rather than imported so this package stays
 * independent of the gateway. Keep in step with:
 * - `publicKeyFor` in apps/gateway/src/admin/identity-keys.service.ts (key registration);
 * - `WidgetSessionsService.identify` in apps/gateway/src/widget/sessions.service.ts (verification).
 */
import { IdentityAssertionClaims } from '@hamnivo/contracts';
import { decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';

/** Members a public key may carry, per key type; everything else (such as `d`) is refused. */
const PUBLIC_MEMBERS: Record<string, readonly string[]> = {
  EC: ['kty', 'crv', 'x', 'y'],
  OKP: ['kty', 'crv', 'x'],
  RSA: ['kty', 'n', 'e'],
};
const EXPECTED: Record<string, { kty: string; crv?: string }> = {
  ES256: { kty: 'EC', crv: 'P-256' },
  EdDSA: { kty: 'OKP', crv: 'Ed25519' },
  RS256: { kty: 'RSA' },
};
const IGNORED_MEMBERS = new Set(['kid', 'alg', 'use', 'key_ops', 'ext']);

/** Checks a public JWK for the algorithm and returns only its public members. */
export async function publicKeyFor(
  alg: 'ES256' | 'EdDSA' | 'RS256',
  jwk: Record<string, unknown>,
): Promise<Record<string, string>> {
  const expected = EXPECTED[alg] as { kty: string; crv?: string };
  if (jwk.kty !== expected.kty || (expected.crv && jwk.crv !== expected.crv)) {
    throw new Error(
      `${alg} needs a ${expected.kty}${expected.crv ? ` ${expected.crv}` : ''} public key.`,
    );
  }
  const allowed = PUBLIC_MEMBERS[expected.kty] ?? [];
  const extra = Object.keys(jwk).filter((k) => !allowed.includes(k) && !IGNORED_MEMBERS.has(k));
  if (extra.length > 0) {
    throw new Error(`Send the public key only (remove: ${extra.join(', ')}).`);
  }
  const clean = Object.fromEntries(allowed.map((k) => [k, jwk[k]])) as Record<string, string>;
  if (Object.values(clean).some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new Error('The key is incomplete.');
  }
  if (alg === 'RS256' && Buffer.from(clean.n ?? '', 'base64url').length < 256) {
    throw new Error('RSA keys must have at least 2048 bits.');
  }
  try {
    await importJWK(clean as JWK, alg);
  } catch {
    throw new Error('The key could not be read.');
  }
  return clean;
}

/** A key as the gateway stores it for a brand. */
export interface RegisteredKey {
  kid: string;
  alg: 'ES256' | 'EdDSA' | 'RS256' | 'HS256';
  status?: 'active' | 'retiring' | 'revoked';
  /** What `publicKeyFor` returned at registration. */
  publicJwk?: Record<string, string>;
  /** HS256: the secret shown once at registration. */
  secret?: string;
}

/** The verification steps of `identify`, with the same jose options. Throws where it refuses. */
export async function verifyLikeGateway(
  assertion: string,
  keys: RegisteredKey[],
  widgetId: string,
  now: Date = new Date(),
) {
  const kid = decodeProtectedHeader(assertion).kid;
  if (!kid) throw new Error('The identity assertion has no key id (kid).');
  const key = keys.find(
    (k) => k.kid === kid && ['active', 'retiring'].includes(k.status ?? 'active'),
  );
  if (!key) throw new Error('Unknown signing key.');
  const verificationKey =
    key.alg === 'HS256'
      ? new TextEncoder().encode(key.secret)
      : await importJWK(key.publicJwk as JWK, key.alg);
  const verified = await jwtVerify(assertion, verificationKey, {
    algorithms: [key.alg],
    audience: widgetId,
    maxTokenAge: '5m',
    currentDate: now,
    requiredClaims: ['sub', 'exp', 'iat', 'jti'],
  });
  const payload = IdentityAssertionClaims.parse(verified.payload);
  if (payload.exp - payload.iat > 300) {
    throw new Error('Identity assertions may be valid for at most five minutes.');
  }
  return { header: verified.protectedHeader, payload };
}
