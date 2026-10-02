# @hamnivo/server

Hamnivo Connect for servers. Your website's backend uses it for two things:

- to tell Hamnivo Chat who a signed-in customer is. It signs a short-lived identity assertion. The
  chat exchanges it for a verified session, and the customer sees their own conversations on any
  device;
- to check that a webhook request really comes from Hamnivo ([Verify webhooks](#verify-webhooks)).

The whole identity flow, from registering a key to signing out, is in
[`docs/guides/identity.md`](../../docs/guides/identity.md); webhooks are in
[`docs/guides/webhooks.md`](../../docs/guides/webhooks.md). A runnable example of both is in
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

## Verify webhooks

Hamnivo signs every webhook request the
[Standard Webhooks](https://www.standardwebhooks.com/) way, with the endpoint's `whsec_…`
secret. `verifyWebhook` checks the signature, the timestamp and, with a replay store, that the
request was not accepted before. Pass the body exactly as it arrived, before any JSON parsing.

```ts
import express from 'express';
import { HamnivoWebhookError, MemoryReplayStore, verifyWebhook } from '@hamnivo/server';

const replayStore = new MemoryReplayStore(); // one process; use Redis or your database for more

app.post('/hamnivo/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body, req.headers, {
      secret: process.env.HAMNIVO_WEBHOOK_SECRET, // or [current, previous] while rotating
      replayStore,
    });
  } catch (error) {
    if (error instanceof HamnivoWebhookError && error.code === 'duplicate') {
      res.sendStatus(200); // already accepted: answer 2xx so it is not sent again
      return;
    }
    res.sendStatus(400);
    return;
  }
  try {
    await handle(event); // event.id is the same on every retry: deduplicate on it
    res.sendStatus(204);
  } catch {
    await replayStore.release(event.id); // let Hamnivo's retry be processed
    res.sendStatus(500);
  }
});
```

| Check | Refused with `error.code` |
|---|---|
| `webhook-id`, `webhook-timestamp` and `webhook-signature` are present | `missing_header` |
| The timestamp is a number of seconds | `invalid_timestamp` |
| It is at most `toleranceSeconds` (default 300) from now, either way | `timestamp_out_of_range` |
| One `v1` signature matches one of the secrets (constant-time) | `invalid_signature` |
| The body is a JSON object | `invalid_payload` |
| The replay store has not seen the id within twice the tolerance | `duplicate` |

- During a secret rotation, requests carry one signature per secret. Pass both secrets, or keep
  the old one until the overlap ends.
- A replay store refuses a captured request sent again within the tolerance window. Hamnivo's
  own retries use the same `webhook-id` with a new timestamp, so they are refused as `duplicate`
  too: answer them 2xx. For deduplication across the days retries can span, store processed
  event ids in your database.
- `signWebhook(secret, id, timestamp, body)` makes a signature as Hamnivo does, for tests of
  your receiver.
- It uses Web Crypto only, so it also runs in edge runtimes. It does not use the official
  `standardwebhooks` package, which reads the clock itself and has no replay protection; it is
  checked against that project's published test vectors instead.

## Checks

```bash
pnpm --filter @hamnivo/server test
```

The webhook tests check signatures against the vectors published with the Standard Webhooks
reference libraries, and every refusal in the table above.

The tests verify every assertion the way the gateway does. They use a copy of its steps and its
jose options, and `IdentityAssertionClaims` from `@hamnivo/contracts`. They cover every
algorithm, the lifetime limits, unique `jti` values and each input error. A copy of the gateway's
public key rules checks that generated keys register as they are.
