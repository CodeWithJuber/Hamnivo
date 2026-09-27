# @hamnivo/server

Hamnivo Connect for servers. Your website's backend uses it to tell Hamnivo Chat who a signed-in
customer is. It signs a short-lived identity assertion. The chat exchanges it for a verified
session, and the customer sees their own conversations on any device.

The whole flow, from registering a key to signing out, is in
[`docs/guides/identity.md`](../../docs/guides/identity.md). A runnable example is in
[`examples/node-express`](../../examples/node-express).

It needs Node 22.12 or later. Its only dependency is [jose](https://github.com/panva/jose).

## Sign an assertion

```ts
import { createIdentityAssertion } from '@hamnivo/server';

// In a route that only signed-in customers reach. Take the customer from your session.
const assertion = await createIdentityAssertion({
  widgetId: 'wid_…', // the brand's widget ID
  key: { kid: 'shop-2026-09', alg: 'ES256', privateKey }, // a JWK, CryptoKey or KeyObject
  customer: { id: user.id, name: user.name, email: user.email, emailVerified: true },
});
// Send it to the page, which calls: await Hamnivo.identify(assertion)
```

With an HS256 key, pass the secret Hamnivo showed when you registered it:

```ts
key: { kid: 'hk_…', alg: 'HS256', secret: process.env.HAMNIVO_IDENTITY_SECRET }
```

Sign a new assertion for every `identify` call. Hamnivo accepts each one once.

### What it signs

| Part | Value |
|---|---|
| Header | `alg` and `kid` from `key`, and `typ: "JWT"` |
| `sub` | `customer.id`: your stable id for the account, 1 to 200 characters |
| `aud` | `widgetId` |
| `iat` | now, minus 5 seconds (see below) |
| `exp` | `iat` plus `ttlSeconds`: 120 by default; larger values are capped at 300 |
| `jti` | 16 random bytes, base64url; new every time |
| `name` | `customer.name`, at most 120 characters |
| `email` | `customer.email`, an address Hamnivo accepts |
| `email_verified` | `customer.emailVerified`. Hamnivo keeps the email only when it is `true`. |

Optional customer fields that are missing or `null` are left out.

Hamnivo refuses an assertion issued in the future, even by one second. So `iat` is dated five
seconds back, and a server clock that runs slightly fast still works. An assertion therefore stays
valid for `ttlSeconds` minus 5 seconds.

## Make a key pair

```ts
import { generateIdentityKey, identityKeyRequest } from '@hamnivo/server';

const key = await generateIdentityKey(); // ES256; or 'EdDSA' or 'RS256'
const body = identityKeyRequest(key.publicJwk, key.kid);
// POST body for /v1/admin/brands/{brandId}/identity-keys.
// Keep key.privateJwk in your secret store. Never send it anywhere.
```

- `kid` is the key's RFC 7638 thumbprint. You may register the key under another kid.
- `publicJwk` has the public members only, as Hamnivo stores them.
- `identityKeyRequest` keeps only those members, and refuses a private key or a key type Hamnivo
  does not accept.
- HS256 secrets are made by Hamnivo. Register `{ "alg": "HS256" }` and keep the secret it shows
  once.

## Errors

Bad input throws a `HamnivoIdentityError`, and nothing is signed. The message says what to fix.
It never repeats the values passed in, so it is safe to log. The checks match the gateway's, so
input it would refuse fails here instead of in the customer's browser:

- a widget ID that does not start with `wid_`;
- a customer id that is empty or longer than 200 characters, a name longer than 120 characters, or
  an email address the gateway refuses;
- a kid the gateway cannot register, or an algorithm other than ES256, EdDSA, RS256 or HS256;
- a missing key, or a key that does not fit the algorithm: a secret for ES256, a public key, a
  PEM string, the wrong curve, or an RSA key under 2048 bits;
- a lifetime under 10 seconds or not in whole seconds.

## Checks

```bash
pnpm --filter @hamnivo/server test
```

The tests verify every assertion the way the gateway does. They use a copy of its steps and its
jose options, and `IdentityAssertionClaims` from `@hamnivo/contracts`. They cover every
algorithm, the lifetime limits, unique `jti` values and each input error. A copy of the gateway's
public key rules checks that generated keys register as they are.
