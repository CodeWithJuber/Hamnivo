import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { IdentityAssertionClaims } from '@hamnivo/contracts';
import { base64url, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createIdentityAssertion,
  type GeneratedIdentityKey,
  generateIdentityKey,
  HamnivoIdentityError,
  type IdentityAssertionOptions,
  identityKeyRequest,
} from '../src/index.js';
import { publicKeyFor, type RegisteredKey, verifyLikeGateway } from './gateway.js';

const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const customer = {
  id: 'customer-42',
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  emailVerified: true,
};
/** The shape of the secret the gateway shows once for an HS256 key. */
const secret = randomBytes(32).toString('base64url');
const hs256: RegisteredKey = { kid: 'hk_shop', alg: 'HS256', secret };

const keys = {} as Record<'ES256' | 'EdDSA' | 'RS256', GeneratedIdentityKey>;

beforeAll(async () => {
  [keys.ES256, keys.EdDSA, keys.RS256] = await Promise.all([
    generateIdentityKey('ES256'),
    generateIdentityKey('EdDSA'),
    generateIdentityKey('RS256'),
  ]);
});

/** Registers a generated key the way the gateway does, returning what it stores. */
async function register(key: GeneratedIdentityKey): Promise<RegisteredKey> {
  const body = identityKeyRequest(key.publicJwk, key.kid);
  return { kid: key.kid, alg: key.alg, publicJwk: await publicKeyFor(body.alg, body.publicJwk) };
}

function hsOptions(overrides: Partial<IdentityAssertionOptions> = {}): IdentityAssertionOptions {
  return {
    widgetId: WIDGET,
    key: { kid: hs256.kid, alg: 'HS256', secret },
    customer,
    ...overrides,
  };
}

async function failure(options: unknown): Promise<HamnivoIdentityError> {
  const error = await createIdentityAssertion(options as IdentityAssertionOptions).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HamnivoIdentityError);
  return error as HamnivoIdentityError;
}

describe('createIdentityAssertion', () => {
  it.each(['ES256', 'EdDSA', 'RS256'] as const)(
    'signs %s assertions that the gateway verifies',
    async (alg) => {
      const key = keys[alg];
      const assertion = await createIdentityAssertion({
        widgetId: WIDGET,
        key: { kid: key.kid, alg, privateKey: key.privateJwk },
        customer,
      });
      const { header, payload } = await verifyLikeGateway(assertion, [await register(key)], WIDGET);
      expect(header).toEqual({ alg, kid: key.kid, typ: 'JWT' });
      expect(payload).toMatchObject({
        sub: 'customer-42',
        aud: WIDGET,
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        email_verified: true,
      });
      expect(payload.exp - payload.iat).toBe(120);
    },
  );

  it('signs HS256 assertions with the secret exactly as Hamnivo showed it', async () => {
    const assertion = await createIdentityAssertion(hsOptions());
    const { header, payload } = await verifyLikeGateway(assertion, [hs256], WIDGET);
    expect(header).toEqual({ alg: 'HS256', kid: 'hk_shop', typ: 'JWT' });
    expect(payload.sub).toBe('customer-42');
    // The gateway's HMAC key is the secret's characters; a decoded secret is a different key.
    await expect(
      jwtVerify(assertion, base64url.decode(secret), { algorithms: ['HS256'] }),
    ).rejects.toThrow();
  });

  it('accepts the private key as a JWK, a CryptoKey or a Node KeyObject', async () => {
    const web = await generateKeyPair('ES256');
    const node = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = node.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const cases = [
      { privateKey: keys.ES256.privateJwk, publicJwk: keys.ES256.publicJwk },
      { privateKey: web.privateKey, publicJwk: await exportJWK(web.publicKey) },
      { privateKey: node.privateKey, publicJwk: node.publicKey.export({ format: 'jwk' }) },
      { privateKey: createPrivateKey(pem), publicJwk: node.publicKey.export({ format: 'jwk' }) },
    ];
    for (const { privateKey, publicJwk } of cases) {
      const assertion = await createIdentityAssertion({
        widgetId: WIDGET,
        key: { kid: 'shop-2026', alg: 'ES256', privateKey },
        customer,
      });
      const stored = await publicKeyFor('ES256', publicJwk as Record<string, unknown>);
      const key: RegisteredKey = { kid: 'shop-2026', alg: 'ES256', publicJwk: stored };
      await expect(verifyLikeGateway(assertion, [key], WIDGET)).resolves.toBeDefined();
    }
  });

  it('signs the customer, the audience, the times and a jti, and nothing else', async () => {
    const full = decodeJwt(
      await createIdentityAssertion({
        widgetId: WIDGET,
        key: { kid: keys.ES256.kid, alg: 'ES256', privateKey: keys.ES256.privateJwk },
        customer,
      }),
    );
    expect(Object.keys(full)).toEqual([
      'sub',
      'aud',
      'iat',
      'exp',
      'jti',
      'name',
      'email',
      'email_verified',
    ]);
    expect(JSON.stringify(full)).not.toContain(keys.ES256.privateJwk.d);

    const bare = decodeJwt(
      await createIdentityAssertion(
        hsOptions({ customer: { id: 'customer-7', name: null, email: null, emailVerified: null } }),
      ),
    );
    expect(Object.keys(bare)).toEqual(['sub', 'aud', 'iat', 'exp', 'jti']);
    expect(IdentityAssertionClaims.parse(bare).sub).toBe('customer-7');
  });

  it('keeps an unverified email marked as unverified', async () => {
    const assertion = await createIdentityAssertion(
      hsOptions({
        customer: { id: 'customer-8', email: 'omar@example.com', emailVerified: false },
      }),
    );
    const { payload } = await verifyLikeGateway(assertion, [hs256], WIDGET);
    expect(payload).toMatchObject({ email: 'omar@example.com', email_verified: false });
  });

  it('gives every assertion a fresh 16-byte jti', async () => {
    const jtis = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const { jti } = decodeJwt(await createIdentityAssertion(hsOptions()));
        return jti as string;
      }),
    );
    expect(new Set(jtis).size).toBe(200);
    for (const jti of jtis) {
      expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(base64url.decode(jti)).toHaveLength(16);
    }
  });

  it('accepts exactly the email addresses the gateway contract accepts', async () => {
    const addresses = [
      'ayesha@example.com',
      'a.b+tag@mail.example.co',
      "o'neil@example.ie",
      'first_last@example.museum',
      'UPPER@EXAMPLE.COM',
      'josé@example.com',
      'a@b',
      'a@b.c',
      '.a@example.com',
      'a.@example.com',
      'a..b@example.com',
      'a@-example.com',
      'a@example..com',
      'a b@example.com',
      'a@example.com ',
      '@example.com',
      'a@example.c0m',
    ];
    for (const email of addresses) {
      const expected = IdentityAssertionClaims.shape.email.safeParse(email).success;
      const signed = await createIdentityAssertion(hsOptions({ customer: { id: 'c-1', email } }))
        .then(() => true)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(HamnivoIdentityError);
          return false;
        });
      expect(signed, email).toBe(expected);
    }
  });
});

describe('lifetime', () => {
  const ttlOf = async (ttlSeconds?: number) => {
    const assertion = await createIdentityAssertion(hsOptions({ ttlSeconds }));
    const { payload } = await verifyLikeGateway(assertion, [hs256], WIDGET);
    return payload.exp - payload.iat;
  };

  it('is 120 seconds by default and at most 300', async () => {
    expect(await ttlOf()).toBe(120);
    expect(await ttlOf(10)).toBe(10);
    expect(await ttlOf(60)).toBe(60);
    expect(await ttlOf(300)).toBe(300);
    expect(await ttlOf(301)).toBe(300);
    expect(await ttlOf(86_400)).toBe(300);
  });

  it.each([9, 0, -60, 90.5, Number.NaN, Number.POSITIVE_INFINITY, '60'])(
    'refuses a lifetime of %o',
    async (ttlSeconds) => {
      const error = await failure(hsOptions({ ttlSeconds: ttlSeconds as number }));
      expect(error.message).toMatch(/ttlSeconds must be a whole number of seconds, at least 10/);
    },
  );

  it('dates iat five seconds back, so a gateway clock a little behind still accepts it', async () => {
    const before = Math.floor(Date.now() / 1000);
    const assertion = await createIdentityAssertion(hsOptions());
    const after = Math.floor(Date.now() / 1000);
    const { iat, exp } = decodeJwt(assertion) as { iat: number; exp: number };
    expect(iat).toBeGreaterThanOrEqual(before - 5);
    expect(iat).toBeLessThanOrEqual(after - 5);
    expect(exp).toBe(iat + 120);

    const behind = new Date(Date.now() - 4_000);
    await expect(verifyLikeGateway(assertion, [hs256], WIDGET, behind)).resolves.toBeDefined();
    // Without the allowance the same gateway refuses it: the token looks issued in the future.
    const undated = await new SignJWT({ jti: 'undated-assertion' })
      .setProtectedHeader({ alg: 'HS256', kid: hs256.kid })
      .setSubject('customer-42')
      .setAudience(WIDGET)
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(new TextEncoder().encode(secret));
    await expect(verifyLikeGateway(undated, [hs256], WIDGET, behind)).rejects.toThrow(/iat/);
  });

  it('stops verifying once it expires', async () => {
    const assertion = await createIdentityAssertion(hsOptions({ ttlSeconds: 60 }));
    const { exp } = decodeJwt(assertion) as { exp: number };
    const at = (seconds: number) => new Date(seconds * 1000);
    await expect(verifyLikeGateway(assertion, [hs256], WIDGET, at(exp - 1))).resolves.toBeDefined();
    await expect(verifyLikeGateway(assertion, [hs256], WIDGET, at(exp))).rejects.toThrow(/exp/);
  });
});

describe('input errors', () => {
  const es256 = (key: Record<string, unknown>) => ({
    widgetId: WIDGET,
    key: { kid: 'shop-2026', alg: 'ES256', ...key },
    customer,
  });
  const withCustomer = (changes: Record<string, unknown>) =>
    hsOptions({ customer: { ...customer, ...changes } as IdentityAssertionOptions['customer'] });

  const cases: [string, () => unknown, RegExp][] = [
    ['no options', () => undefined, /Pass \{ widgetId, key, customer \}/],
    ['an empty customer id', () => withCustomer({ id: '' }), /customer\.id is empty/],
    ['a blank customer id', () => withCustomer({ id: '   ' }), /customer\.id is empty/],
    ['a numeric customer id', () => withCustomer({ id: 42 }), /customer\.id must be a string/],
    [
      'a customer id over 200 characters',
      () => withCustomer({ id: 'x'.repeat(201) }),
      /customer\.id is longer than 200/,
    ],
    [
      'a name over 120 characters',
      () => withCustomer({ name: 'x'.repeat(121) }),
      /customer\.name is longer than 120/,
    ],
    ['a name that is not text', () => withCustomer({ name: 7 }), /customer\.name must be/],
    ['an email Hamnivo refuses', () => withCustomer({ email: 'nobody' }), /customer\.email/],
    [
      'an emailVerified that is not true or false',
      () => withCustomer({ emailVerified: 'yes' }),
      /customer\.emailVerified must be true or false/,
    ],
    ['no customer', () => hsOptions({ customer: undefined as never }), /customer is required/],
    [
      'a brand ID instead of the widget ID',
      () => hsOptions({ widgetId: 'brd_01j9zk7w3xq8r4t2v6m5n1p0ce' }),
      /widget ID, which starts with wid_/,
    ],
    ['no key', () => hsOptions({ key: undefined as never }), /key is required/],
    [
      'a kid Hamnivo cannot register',
      () => hsOptions({ key: { kid: 'shop key', alg: 'HS256', secret } }),
      /key\.kid must be the key id/,
    ],
    [
      'an algorithm Hamnivo does not accept',
      () => hsOptions({ key: { kid: 'k1', alg: 'HS512' as never, secret } }),
      /key\.alg must be ES256, EdDSA, RS256 or HS256/,
    ],
    [
      'HS256 without a secret',
      () => hsOptions({ key: { kid: 'k1', alg: 'HS256' } }),
      /HS256 needs key\.secret/,
    ],
    [
      'a secret with a line break',
      () => hsOptions({ key: { kid: 'k1', alg: 'HS256', secret: `${secret}\n` } }),
      /spaces or line breaks/,
    ],
    [
      'HS256 with a private key',
      () =>
        hsOptions({ key: { kid: 'k1', alg: 'HS256', secret, privateKey: keys.ES256.privateJwk } }),
      /HS256 signs with key\.secret/,
    ],
    ['ES256 without a private key', () => es256({}), /ES256 needs key\.privateKey/],
    ['ES256 with a secret', () => es256({ secret }), /key\.secret is for HS256 only/],
    [
      'an Ed25519 key for ES256',
      () => es256({ privateKey: keys.EdDSA.privateJwk }),
      /ES256 needs an EC P-256 private key/,
    ],
    [
      'an RSA key for EdDSA',
      () => ({
        widgetId: WIDGET,
        key: { kid: 'k1', alg: 'EdDSA', privateKey: keys.RS256.privateJwk },
        customer,
      }),
      /EdDSA needs an Ed25519 private key/,
    ],
    [
      'a public JWK',
      () => es256({ privateKey: keys.ES256.publicJwk }),
      /key\.privateKey is a public key/,
    ],
    [
      'a JWK marked for another algorithm',
      () => es256({ privateKey: { ...keys.ES256.privateJwk, alg: 'ES384' } }),
      /marked for another algorithm/,
    ],
    [
      'a PEM string',
      () =>
        es256({
          privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ format: 'pem', type: 'pkcs8' })
            .toString(),
        }),
      /crypto\.createPrivateKey/,
    ],
    [
      'a public KeyObject',
      () => es256({ privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey }),
      /is a public key\. Sign with the private key/,
    ],
    [
      'a P-384 KeyObject for ES256',
      () => es256({ privateKey: generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey }),
      /key\.privateKey cannot sign ES256/,
    ],
    [
      'a 1024-bit RSA key',
      () => ({
        widgetId: WIDGET,
        key: {
          kid: 'k1',
          alg: 'RS256',
          privateKey: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey,
        },
        customer,
      }),
      /key\.privateKey cannot sign RS256/,
    ],
  ];

  it.each(cases)('refuses %s', async (_name, build, message) => {
    const error = await failure(build());
    expect(error.name).toBe('HamnivoIdentityError');
    expect(error.message).toMatch(message);
  });

  it('accepts the longest id and name the gateway accepts', async () => {
    const assertion = await createIdentityAssertion(
      withCustomer({ id: 'x'.repeat(200), name: 'y'.repeat(120) }),
    );
    await expect(verifyLikeGateway(assertion, [hs256], WIDGET)).resolves.toBeDefined();
  });

  it('keeps the underlying key error as the cause', async () => {
    const error = await failure(
      es256({ privateKey: generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey }),
    );
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('never repeats a secret put in the wrong place', async () => {
    const misplaced = [
      hsOptions({ widgetId: secret }),
      hsOptions({ key: { kid: `${secret}!`, alg: 'HS256', secret } }),
      hsOptions({ key: { kid: 'k1', alg: secret as never, secret } }),
      hsOptions({ key: { kid: 'k1', alg: 'HS256', secret: ` ${secret}` } }),
      es256({ privateKey: secret }),
      withCustomer({ email: secret }),
    ];
    for (const options of misplaced) {
      const error = await failure(options);
      expect(error.message).not.toContain(secret);
    }
  });
});
