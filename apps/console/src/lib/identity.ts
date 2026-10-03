/**
 * Customer identity keys (W12): the keys that check the identity assertions a brand's own server
 * signs for its signed-in customers. Managing them needs the identity-keys permission, two-step
 * verification and a recent sign-in; the gateway enforces all three and Studio asks to sign in
 * again when it has to.
 */
import type { CreatedIdentityKey, IdentityKey } from '@hamnivo/contracts';
import { useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type { CreatedIdentityKey, IdentityKey };

export const identityKeysKey = (brandId: string) => ['identity-keys', brandId] as const;

/** The brand's keys, newest first. */
export function useIdentityKeys(brandId: string | undefined) {
  const { can } = useTenant();
  return useStudioQuery<{ items: IdentityKey[] }>(
    identityKeysKey(brandId ?? ''),
    `/v1/admin/brands/${brandId ?? ''}/identity-keys`,
    { enabled: can('widget.identity_keys') && brandId !== undefined },
  );
}

/** The signature types, in the order they are offered. */
export const PUBLIC_ALGORITHMS = ['ES256', 'EdDSA', 'RS256'] as const;
export type PublicAlgorithm = (typeof PUBLIC_ALGORITHMS)[number];

/** A key name the gateway accepts: letters, digits, dot, underscore and dash, 1 to 64 long. */
export const isKeyName = (value: string) => /^[A-Za-z0-9._-]{1,64}$/.test(value);

/** Members of a JWK that belong to a private key: a public key never has them. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export type JwkProblem = 'json' | 'object' | 'private';

/** Reads the pasted public key, or says what is wrong with it. A private key is never accepted. */
export function parseJwk(text: string): { jwk: Record<string, unknown> } | { problem: JwkProblem } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'json' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problem: 'object' };
  }
  const jwk = value as Record<string, unknown>;
  if (PRIVATE_MEMBERS.some((member) => member in jwk)) return { problem: 'private' };
  return { jwk };
}
