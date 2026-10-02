# Verified customers with Express

A small Express 5 website with a fake sign-in. It tells Hamnivo Chat who is signed in, using
[`@hamnivo/server`](../../packages/server-sdk). The whole flow is explained in
[`docs/guides/identity.md`](../../docs/guides/identity.md).

## What it shows

- **`GET /hamnivo/identity`** in [`src/app.ts`](src/app.ts). It signs a fresh identity assertion
  for the signed-in customer.
  - It answers 401 to a visitor who is not signed in.
  - It takes the customer from the server's own records, never from the request.
  - It sends `Cache-Control: no-store`, so no cache keeps an assertion.
  - The key never leaves the server. On an error, the browser gets no details.
- **[`public/identity.js`](public/identity.js)**, the browser part.
  - When the customer is signed in, it fetches an assertion and calls `Hamnivo.identify`.
  - On sign-out, it calls `Hamnivo.reset()` first. It waits at most 3 seconds, so a chat that
    cannot load never blocks sign-out.
- **The fake sign-in.** A signed cookie holds the user id, and a restart signs everyone out. Use
  your website's real sign-in instead.
- **`POST /hamnivo/webhooks`** in [`src/app.ts`](src/app.ts), mounted when
  `HAMNIVO_WEBHOOK_SECRET` is set. It receives Hamnivo's webhooks
  ([`docs/guides/webhooks.md`](../../docs/guides/webhooks.md)).
  - It verifies the signature on the raw body with `verifyWebhook`, and refuses a request that is
    forged, changed or older than five minutes (400).
  - It handles each event id once: a retry of an event it already handled gets 200.
  - When handling fails it answers 500 and forgets the id, so Hamnivo's retry is processed.

## Run it

It needs a running Hamnivo (see [`docs/self-hosting.md`](../../docs/self-hosting.md)) and a brand
with its widget ID.

1. Build the SDK and the example:

   ```bash
   pnpm install
   pnpm exec turbo run build --filter=@hamnivo/example-node-express...
   ```

2. Make a key pair. This prints the request that registers the public key, and the lines for
   `.env`:

   ```bash
   pnpm --filter @hamnivo/example-node-express keygen          # ES256; or add EdDSA or RS256
   ```

   Register the public key for the brand, as shown in the guide. To use an HS256 secret instead,
   register an HS256 key and put its secret in `HAMNIVO_IDENTITY_SECRET`.

3. Copy `.env.example` to `.env` in this folder and fill it in:

   | Setting | Meaning |
   |---|---|
   | `HAMNIVO_WIDGET_ID` | The brand's widget ID (`wid_…`). |
   | `HAMNIVO_IDENTITY_KID` | The key id you registered. |
   | `HAMNIVO_IDENTITY_KEY` | The private JWK (ES256, EdDSA or RS256), as JSON in single quotes. |
   | `HAMNIVO_IDENTITY_SECRET` | Or the HS256 secret Hamnivo showed once. |
   | `HAMNIVO_WIDGET_ORIGIN` | Where Hamnivo Chat serves `loader.js`. Default `http://localhost:5174`. |
   | `HAMNIVO_API` | The Hamnivo API. Default `http://localhost:4000`. |
   | `HAMNIVO_WEBHOOK_SECRET` | Optional: the `whsec_…` secret of a webhook endpoint for `/hamnivo/webhooks`. Both secrets, comma-separated, while rotating. |
   | `PORT` | This website's port. Default `8080`. |

4. Start it:

   ```bash
   pnpm --filter @hamnivo/example-node-express start
   ```

   It signs one test assertion first, so a wrong widget ID or key stops it with a clear message.

5. Open `http://localhost:8080`. The brand's allowed websites must include this origin. A brand
   that lists no website accepts local pages only.

## Test

```bash
pnpm --filter @hamnivo/example-node-express test
```

The tests start the app on a free port and call it with `fetch`. They check that:

- the identity route refuses signed-out visitors and forged cookies (401);
- an assertion verifies with the matching public key or secret, using the gateway's own checks;
- the signed customer comes from the server's records, even when the request names another one;
- no response ever contains the private key or the secret;
- a missing or unreadable setting gives a clear message that never repeats the key;
- `public/identity.js` (run in jsdom) identifies a signed-in customer once the loader is ready,
  and signs out within 3 seconds even when the chat never answers;
- the webhook route handles a signed event once, accepts the previous secret during a rotation,
  refuses forged, altered and stale requests, and processes a retry after a failure.

## In your own app

- Add `@hamnivo/server` to your server's dependencies.
- Copy the identity route. Put it behind your own sign-in, and take the customer from your session.
- Keep the private key or secret in your secret store, not in code.
- Copy `public/identity.js`, and change the sign-out part to match your pages.
- For webhooks, copy the webhook route. With more than one server process, use a shared replay
  store (Redis or your database), and store handled event ids so retries days later are skipped.
