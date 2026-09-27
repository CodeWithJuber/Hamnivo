# Verified customers

Chat visitors start anonymous. When a customer is signed in to your website, the website can tell
Hamnivo Chat who they are. A verified customer sees their own conversations, on any device.

Your server vouches for the customer. It signs a short-lived identity assertion with a key that you
registered in Hamnivo. The page passes the assertion to the chat. Hamnivo checks it and starts a
verified session for that customer.

Nothing the browser says about a customer counts. Only your server's signature does.

## The flow

1. Register a key for the brand, once.
2. On your server, sign an assertion for the signed-in customer.
3. In the page, pass it to `Hamnivo.identify(assertion)`.
4. When the customer signs out, call `Hamnivo.reset()`.

A runnable version of all four steps is in [`examples/node-express`](../../examples/node-express).

## 1. Register a key

### Who can register keys

A key lets its holder vouch for any customer of the brand. So managing keys needs all of these:

- the `widget.identity_keys` permission for the brand (the Owner and Admin roles have it);
- two-step verification turned on;
- a sign-in in the last 10 minutes (`STEP_UP_MAX_AGE_MINUTES`).

Otherwise the API answers `MFA_REQUIRED` or `REAUTH_REQUIRED`. API keys cannot manage identity
keys. A person must do it.

The commands below use curl, as in Part A of [`docs/self-hosting.md`](../self-hosting.md). Sign in
there first (step 3 of A6). Then set these, with your own addresses and IDs:

```bash
A=https://api.example.com; O=https://app.example.com
T=tnt_...   # your company (tenant) ID
B=brd_...   # the brand ID
h=(-c jar -b jar -H "origin: $O" -H 'content-type: application/json' -H "x-hamnivo-tenant: $T")
```

### Turn on two-step verification

Do this once:

```bash
curl "${h[@]}" -d '{"password":"your password"}' $A/api/auth/two-factor/enable
```

It returns a `totpURI` and backup codes. Add the `totpURI` to your authenticator app, and keep the
backup codes somewhere safe. Then confirm with the app's current code:

```bash
curl "${h[@]}" -d '{"code":"123456"}' $A/api/auth/two-factor/verify-totp
```

### Sign in again when your sign-in is older than 10 minutes

```bash
curl "${h[@]}" -d '{"email":"you@example.com","password":"your password"}' $A/api/auth/sign-in/email
curl "${h[@]}" -d '{"code":"123456"}' $A/api/auth/two-factor/verify-totp
```

The first command answers `{"twoFactorRedirect":true}`. The second one finishes the sign-in.

### Choose a key type

| Type | Who holds what | Choose it when |
|---|---|---|
| HS256 | Hamnivo makes a shared secret and shows it once. Your server and Hamnivo both keep it. | You want the simplest setup, or your JWT library does only HMAC. |
| ES256 | You make a key pair. Hamnivo stores only the public key. | You want Hamnivo to hold nothing that can sign. This is the better choice. |

EdDSA (Ed25519) and RS256 keys (2048 bits or more) work the same way as ES256.

### Register an HS256 key

```bash
curl "${h[@]}" -d '{"alg":"HS256","kid":"shop-2026-09"}' $A/v1/admin/brands/$B/identity-keys
```

The answer has a `secret`. Hamnivo shows it only this once, so put it in your server's secret
store now. The `kid` is optional. Without it, Hamnivo picks one (`hk_…`) and returns it.

### Register an ES256 key

Make the key pair on your server with `@hamnivo/server`:

```ts
import { generateIdentityKey, identityKeyRequest } from '@hamnivo/server';

const key = await generateIdentityKey(); // ES256
console.log(JSON.stringify(identityKeyRequest(key.publicJwk, key.kid))); // the request body
// Put key.kid and key.privateJwk in your secret store.
```

The Express example has this as a command: `pnpm --filter @hamnivo/example-node-express keygen`.
Then register the public key:

```bash
curl "${h[@]}" -d '{"alg":"ES256","publicJwk":{"kty":"EC","crv":"P-256","x":"…","y":"…"},"kid":"…"}' \
  $A/v1/admin/brands/$B/identity-keys
```

Hamnivo refuses a key with private members, such as `d`. The private key never leaves your server.

To list the brand's keys and their status:

```bash
curl "${h[@]}" $A/v1/admin/brands/$B/identity-keys
```

## 2. Sign an assertion on your server

Add an endpoint that only signed-in customers can reach, for example `GET /hamnivo/identity`. It
signs an assertion for the customer in the session. With Express:

```ts
import { createIdentityAssertion } from '@hamnivo/server';

// requireSignIn stands for your own sign-in check.
app.get('/hamnivo/identity', requireSignIn, async (req, res) => {
  const user = req.user; // from your session, never from the request
  const assertion = await createIdentityAssertion({
    widgetId: 'wid_…',
    key: { kid: 'shop-2026-09', alg: 'ES256', privateKey }, // or { kid, alg: 'HS256', secret }
    customer: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified },
  });
  res.set('cache-control', 'no-store').json({ assertion });
});
```

An assertion is valid for 120 seconds by default. Set `ttlSeconds` to change it, up to 300.
`@hamnivo/server` refuses input that Hamnivo would refuse, with a `HamnivoIdentityError` that says
what to fix. Its README lists the details: [`packages/server-sdk`](../../packages/server-sdk).

### What Hamnivo checks

| Part | Rule |
|---|---|
| `kid` header | Names a key of this brand that is active or retiring. |
| `alg` header | The algorithm the key was registered with. |
| `aud` | The brand's widget ID (`wid_…`). |
| `sub` | Your id for the customer account, 1 to 200 characters. |
| `iat` | At most five minutes ago, and not in the future. |
| `exp` | In the future, and at most 300 seconds after `iat`. |
| `jti` | 8 to 128 characters. Each value is accepted once. |
| `name` | Optional. At most 120 characters. |
| `email` | Optional. A valid address. Kept only when `email_verified` is `true`. |

### Signing without Node

Any JWT library works. Sign a compact JWS with the header and claims above. Two details matter:

- For HS256, the HMAC key is the secret's text, exactly as Hamnivo showed it. Do not
  base64-decode it.
- Hamnivo refuses an `iat` in the future, even by one second. Keep your server's clock in sync, or
  date `iat` a few seconds back. `@hamnivo/server` dates it five seconds back.

## 3. Pass it to the chat

In the page, after the customer signs in, and on later page loads while they stay signed in:

```js
const response = await fetch('/hamnivo/identity', { credentials: 'same-origin' });
if (response.ok) {
  const { assertion } = await response.json();
  await Hamnivo.identify(assertion);
}
```

When the customer signs out, call `Hamnivo.reset()` before your own sign-out. The chat then:
- clears the conversation from the screen;
- ends the session in Hamnivo and in the browser, and forgets unsent messages;
- starts again as an anonymous visitor.

Other open tabs of your website clear their chat too. `reset()` waits for the chat, so don't let
it hold up your sign-out for more than a few seconds:

```js
const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
await Promise.race([Hamnivo.reset().catch(() => {}), timeout]);
```

- Fetch a new assertion for every `identify` call.
- The loader script is `async`, so `window.Hamnivo` may not exist yet when your script runs.
  [`examples/node-express/public/identity.js`](../../examples/node-express/public/identity.js)
  shows how to wait for it.
- `Hamnivo.identify` loads the chat frame if it is not loaded yet.
- `Hamnivo.identify` rejects when Hamnivo refuses the assertion. See
  [Troubleshooting](#troubleshooting-assertion_invalid).
- After `identify`, the chat shows that customer's own conversations.
- `identify` and `reset` reject with `Error('timeout')` when the chat does not answer within 20
  seconds.
- `reset` rejects with `reset_incomplete` when the chat could not reach Hamnivo. The browser has
  still forgotten the session.
- A different `sub` is a different customer, and their conversations are never merged.
  Identifying another customer ends the previous chat session in that browser.

## Rotate a key

Rotate keys on a schedule, and at once if a key may have leaked.

1. Register a new key with a new `kid`. Both keys now verify.
2. Switch your servers to sign with the new key.
3. Retire the old key. A retiring key still verifies, so assertions already signed still work:

   ```bash
   curl "${h[@]}" -d '{}' $A/v1/admin/brands/$B/identity-keys/OLD_KID/retire
   ```

4. When no server signs with the old key any more, wait five minutes. That is the longest an
   assertion lives. Then revoke the old key:

   ```bash
   curl "${h[@]}" -d '{}' $A/v1/admin/brands/$B/identity-keys/OLD_KID/revoke
   ```

A revoked key never verifies again. If a key leaked, revoke it at once, then register and deploy
a new one. Revoking a key does not end chat sessions that it already verified.

## Security

- Keep private keys and secrets on your server, in its secret store. Never put them in browser
  code, a mobile app or a repository.
- Sign only in an endpoint behind your own sign-in. Take the customer from your session. Never
  sign an id, name or email that the request supplies.
- Keep the lifetime short. The default of 120 seconds is enough; the maximum is 300.
- Send `Cache-Control: no-store` with assertions, so no cache keeps them.
- Use one `sub` per customer account: a stable id from your database. Do not use the email
  address, because addresses change and can be reused. Never share one `sub` between accounts.
- Set `emailVerified` to `true` only when your website has confirmed the address.
- Call `Hamnivo.reset()` on sign-out, so the next person on a shared computer starts anonymous.
- Protect the identity endpoint like the rest of your signed-in pages. The Express example uses a
  same-site cookie and answers with JSON and no CORS headers, so other websites cannot read it.

## Troubleshooting `ASSERTION_INVALID`

When Hamnivo refuses an assertion, `Hamnivo.identify` rejects with `identity_rejected`. The reason
is in the browser's network panel. The chat's `POST /v1/widget/identity` answers `401` with
`"code": "ASSERTION_INVALID"` and a `detail`:

| `detail` | Likely cause | Fix |
|---|---|---|
| The identity assertion is malformed. | The page passed something else, such as the whole JSON response. | Pass the `assertion` string itself. |
| The identity assertion has no key id (kid). | The header has no `kid`. | Set `kid` to the registered key id. |
| Unknown signing key. | The `kid` has a typo, belongs to another brand, or was revoked. | Compare it with the brand's key list. |
| The identity assertion could not be verified. | See the list below. | |
| Identity assertions may be valid for at most five minutes. | `exp` is more than 300 seconds after `iat`. | Use a lifetime of 300 seconds or less. |
| This identity assertion was already used. | The same assertion was sent twice: a cached response, a retry or a double call. | Fetch a new assertion for every call, and send `Cache-Control: no-store`. |

"Could not be verified" has several causes. Check them in this order:

1. The signature does not match. The private key or secret is wrong, or the secret was
   base64-decoded or changed.
2. `alg` is not the algorithm the key was registered with.
3. `aud` is not this brand's widget ID. A brand ID (`brd_…`) or another brand's widget ID fails.
4. The assertion expired. Sign it just before `identify`, not in advance.
5. `iat` is more than five minutes old, or in the future. Check your server's clock (use NTP).
6. A claim is out of range or missing: `sub` over 200 characters, `name` over 120, an invalid
   `email`, a `jti` under 8 characters, or no `sub`, `iat`, `exp` or `jti`.

`@hamnivo/server` checks most of these before it signs.

Other problems:

- **`identify` or `reset` rejects with `timeout`.** The chat frame did not load within 20 seconds.
  Check the loader's `src` and `data-widget-id`, and the browser console.
- **The chat does not open, or the API answers `ORIGIN_NOT_ALLOWED`.** Add the page's exact origin
  to the brand's allowed websites. See
  [`examples/html/README.md`](../../examples/html/README.md#allowed-websites).
- **Registering a key answers `MFA_REQUIRED` or `REAUTH_REQUIRED`.** See
  [Who can register keys](#who-can-register-keys).

## Current limits

- The chat does not yet say on screen that the customer is signed in, for example by showing
  their name. See W12 in [`docs/feature-status.md`](../feature-status.md).
