import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { CreateIdentityKeyRequest } from '@hamnivo/contracts';
import { calculateJwkThumbprint, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { generateIdentityKey, HamnivoIdentityError, identityKeyRequest } from '../src/index.js';
import { publicKeyFor } from './gateway.js';

const PUBLIC = {
  ES256: ['crv', 'kty', 'x', 'y'],
  EdDSA: ['crv', 'kty', 'x'],
  RS256: ['e', 'kty', 'n'],
};

describe('generateIdentityKey', () => {
  it.each(['ES256', 'EdDSA', 'RS256'] as const)(
    'makes %s keys that the gateway registers as they are',
    async (alg) => {
      const key = await generateIdentityKey(alg);
      expect(key.alg).toBe(alg);
      expect(Object.keys(key.publicJwk).sort()).toEqual(PUBLIC[alg]);
      // The gateway stores exactly the public key it was given.
      expect(await publicKeyFor(alg, key.publicJwk)).toEqual(key.publicJwk);
      // It would refuse the private key, which has more than public members.
      await expect(publicKeyFor(alg, key.privateJwk)).rejects.toThrow(/public key only/);
      expect(key.privateJwk.d).toEqual(expect.any(String));
      expect(key.privateJwk).toMatchObject(key.publicJwk);
      expect(key.kid).toBe(await calculateJwkThumbprint(key.publicJwk));
      expect(CreateIdentityKeyRequest.parse(identityKeyRequest(key.publicJwk, key.kid))).toEqual({
        alg,
        publicJwk: key.publicJwk,
        kid: key.kid,
      });
    },
  );

  it('makes ES256 keys by default, and a new key every time', async () => {
    const [first, second] = await Promise.all([generateIdentityKey(), generateIdentityKey()]);
    expect(first.alg).toBe('ES256');
    expect(first.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(first.kid).not.toBe(second.kid);
    expect(first.privateJwk.d).not.toBe(second.privateJwk.d);
  });

  it('refuses HS256, whose secrets Hamnivo makes', async () => {
    await expect(generateIdentityKey('HS256' as never)).rejects.toThrow(
      /Hamnivo makes HS256 secrets itself/,
    );
    await expect(generateIdentityKey('ES512' as never)).rejects.toThrow(HamnivoIdentityError);
  });
});

describe('identityKeyRequest', () => {
  it('returns the body that registers the key', async () => {
    const key = await generateIdentityKey('EdDSA');
    const withKid = identityKeyRequest(key.publicJwk, 'shop-2026');
    expect(withKid).toEqual({ alg: 'EdDSA', publicJwk: key.publicJwk, kid: 'shop-2026' });
    expect(CreateIdentityKeyRequest.parse(withKid)).toEqual(withKid);
    const withoutKid = identityKeyRequest(key.publicJwk);
    expect(withoutKid).toEqual({ alg: 'EdDSA', publicJwk: key.publicJwk });
    expect('kid' in withoutKid).toBe(false);
    expect(CreateIdentityKeyRequest.parse(withoutKid)).toEqual(withoutKid);
  });

  it('keeps only the members the gateway stores', async () => {
    const key = await generateIdentityKey();
    const labelled = {
      ...key.publicJwk,
      kid: 'shop-2026',
      alg: 'ES256',
      use: 'sig',
      key_ops: ['verify'],
      ext: true,
      x5t: 'bm90IGEgcmVhbCB0aHVtYnByaW50',
    } as JWK;
    // The gateway refuses members it does not know, such as x5t.
    await expect(publicKeyFor('ES256', labelled)).rejects.toThrow(/remove: x5t/);
    const { publicJwk } = identityKeyRequest(labelled);
    expect(publicJwk).toEqual(key.publicJwk);
    expect(await publicKeyFor('ES256', publicJwk)).toEqual(publicJwk);
  });

  it('refuses a private key, as the gateway does', async () => {
    for (const alg of ['ES256', 'EdDSA', 'RS256'] as const) {
      const key = await generateIdentityKey(alg);
      expect(() => identityKeyRequest(key.privateJwk)).toThrow(/publicJwk is a private key/);
      await expect(publicKeyFor(alg, key.privateJwk)).rejects.toThrow();
    }
  });

  it.each([
    [
      'an EC P-384 key',
      'ES256',
      () => generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' }),
    ],
    [
      'an Ed448 key',
      'EdDSA',
      () => generateKeyPairSync('ed448').publicKey.export({ format: 'jwk' }),
    ],
    [
      'an X25519 key',
      'EdDSA',
      () => generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }),
    ],
    [
      'a 1024-bit RSA key',
      'RS256',
      () => generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' }),
    ],
    ['a secret key', 'ES256', () => ({ kty: 'oct', k: randomBytes(32).toString('base64url') })],
  ] as const)('refuses %s, as the gateway does', async (_name, alg, make) => {
    const jwk = make() as JWK;
    expect(() => identityKeyRequest(jwk)).toThrow(HamnivoIdentityError);
    await expect(publicKeyFor(alg, jwk as Record<string, unknown>)).rejects.toThrow();
  });

  it('refuses an incomplete key or one marked for another algorithm', async () => {
    const { publicJwk } = await generateIdentityKey();
    expect(() => identityKeyRequest({ ...publicJwk, y: '' })).toThrow(/incomplete/);
    expect(() => identityKeyRequest({ kty: 'EC', crv: 'P-256', x: publicJwk.x })).toThrow(
      /incomplete/,
    );
    expect(() => identityKeyRequest({ ...publicJwk, alg: 'ES384' })).toThrow(
      /marked for another algorithm/,
    );
    expect(() => identityKeyRequest('{"kty":"EC"}' as never)).toThrow(/must be a JWK object/);
  });

  it.each(['shop key', 'x'.repeat(65), '', 'kid/with/slashes'])(
    'refuses the kid %j, as the gateway does',
    async (kid) => {
      const { publicJwk } = await generateIdentityKey();
      expect(() => identityKeyRequest(publicJwk, kid)).toThrow(/kid must be 1 to 64/);
      expect(CreateIdentityKeyRequest.safeParse({ alg: 'ES256', publicJwk, kid }).success).toBe(
        false,
      );
    },
  );
});
