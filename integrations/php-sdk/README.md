# hamnivo/hamnivo-php

Hamnivo Connect for PHP servers. It does the same two jobs as
[`@hamnivo/server`](../../packages/server-sdk), and gives the same results:

- It signs the short-lived identity assertion that tells Hamnivo Chat who a signed-in customer is.
  The chat exchanges it for a verified session, and the customer sees their own conversations on
  any device. The whole flow is in [`docs/guides/identity.md`](../../docs/guides/identity.md).
- It checks that a webhook request really comes from Hamnivo
  ([`docs/guides/webhooks.md`](../../docs/guides/webhooks.md)).

It needs PHP 8.1 or later with the `openssl`, `json`, `hash` and `pcre` extensions. EdDSA keys also
need `sodium`: PHP bundles it, and WordPress supplies it when the extension is missing. It has no
other dependencies.

The WordPress plugin ([`integrations/wordpress`](../wordpress)) and the WHMCS addon
([`integrations/whmcs`](../whmcs)) bundle a copy of this SDK. Their users do not run Composer.

## Install

With Composer:

```bash
composer require hamnivo/hamnivo-php
```

Without Composer, copy the `src` folder into your project, and load it with one line:

```php
require __DIR__ . '/hamnivo-php/src/autoload.php';
```

## Sign an assertion

```php
use function Hamnivo\createIdentityAssertion;

// In a route that only signed-in customers reach. Take the customer from your session.
$assertion = createIdentityAssertion([
    'widgetId' => 'wid_…', // the brand's widget ID
    'key' => ['kid' => 'shop-2026-09', 'alg' => 'HS256', 'secret' => $secret],
    'customer' => [
        'id' => (string) $user->ID,
        'name' => $user->display_name,
        'email' => $user->user_email,
        'emailVerified' => true, // only when your website has confirmed the address
    ],
]);
// Send it to the page, which calls: await Hamnivo.identify(assertion)
```

Sign a new assertion for every `identify` call. Hamnivo accepts each one once.

The options are the ones of the Node SDK, written as a PHP array:

| Option | Meaning |
|---|---|
| `widgetId` | The brand's widget ID (`wid_…`). It becomes `aud`. |
| `key.kid`, `key.alg` | The key id you registered, and `ES256`, `EdDSA`, `RS256` or `HS256`. |
| `key.secret` | HS256: the secret Hamnivo showed once, exactly as shown. It is not base64-decoded. |
| `key.privateKey` | The other algorithms: a JWK as an array or as JSON text. ES256 and RS256 also take a PEM private key or an `OpenSSLAsymmetricKey`. |
| `customer.id` | Your stable id for the account, 1 to 200 characters. It becomes `sub`. A whole number is turned into its text. |
| `customer.name`, `customer.email` | Optional. Name at most 120 characters. An address that Hamnivo accepts. |
| `customer.emailVerified` | `true` only when your website confirmed the address. Hamnivo keeps the email only then. |
| `ttlSeconds` | 120 by default, at least 10, at most 300 (larger values are capped). |

Bad input throws `Hamnivo\HamnivoIdentityError` and nothing is signed. Its message says what to
change, and never repeats the values passed in, so it is safe to log.

### The same result as the Node SDK

Given the same input, the PHP and the Node SDK write the same assertion:

- the same header (`alg`, `kid`, `typ: "JWT"`) and the same claims in the same order
  (`sub`, `aud`, `iat`, `exp`, `jti`, `name`, `email`, `email_verified`);
- the same JSON text, down to Unicode, escapes and slashes, and the same base64url;
- `iat` five seconds back, `exp` after `ttlSeconds`, and a `jti` of 16 random bytes;
- the same refusals: widget IDs, key ids, key types, secrets, key sizes, lengths counted in
  UTF-16 units as JavaScript counts them, white space as JavaScript trims it, and the same email
  pattern.

HS256, EdDSA and RS256 signatures are deterministic, so the two SDKs give the same text byte for
byte. An ES256 signature is random each time, so only its header and payload are the same, and
both verify with the public key.

What differs, on purpose:

- A whole number is accepted as `customer.id` (WordPress and WHMCS ids are numbers).
- `key.privateKey` may also be a PEM key or an `OpenSSLAsymmetricKey`, which PHP people have.
- `null` and a missing option mean the same thing.

The tests hold the SDK to this ([Checks](#checks)).

## Verify a webhook

```php
use Hamnivo\HamnivoWebhookError;
use function Hamnivo\verifyWebhook;

$body = file_get_contents('php://input'); // the raw body, before any JSON decoding
try {
    $event = verifyWebhook($body, getallheaders(), [
        'secret' => $_ENV['HAMNIVO_WEBHOOK_SECRET'], // or [current, previous] while rotating
        'replayStore' => $store, // optional, see below
    ]);
} catch (HamnivoWebhookError $error) {
    if ($error->getErrorCode() === HamnivoWebhookError::DUPLICATE) {
        http_response_code(200); // already accepted: answer 2xx so it is not sent again
        exit;
    }
    http_response_code(400);
    exit;
}
// $event['id'] is the same on every retry: deduplicate on it.
```

`verifyWebhook` checks the `v1` signatures of [Standard Webhooks](https://www.standardwebhooks.com/)
in constant time, and the timestamp. It returns the event as an array: `id`, `type`, `timestamp`,
`schemaVersion`, `tenantId` and `data`.

| Check | Refused with `getErrorCode()` |
|---|---|
| `webhook-id`, `webhook-timestamp` and `webhook-signature` are present | `missing_header` |
| The timestamp is a number of seconds | `invalid_timestamp` |
| It is at most `toleranceSeconds` (default 300) from now, either way | `timestamp_out_of_range` |
| One `v1` signature matches one of the secrets | `invalid_signature` |
| The body is a JSON object | `invalid_payload` |
| The replay store has not seen the id within twice the tolerance | `duplicate` |

- Pass the headers as `getallheaders()`, `$request->get_headers()` in WordPress, `$_SERVER`, or the
  headers of a PSR-7 message. Names are matched without regard to case.
- A missing or malformed secret is a setup mistake: it throws `InvalidArgumentException`, not a
  `HamnivoWebhookError`.
- A replay store refuses a captured request sent again. PHP forgets everything between requests, so
  keep the ids in a shared place: implement `Hamnivo\ReplayStore` with a database table that has a
  unique key, Redis `SET NX EX`, or WordPress transients. `MemoryReplayStore` is for tests and for
  long-running PHP.
- `signWebhook($secret, $id, $timestamp, $body)` makes a signature as Hamnivo does, for tests of
  your receiver.

## Keep keys safe

- Keep the secret and private keys on your server, in its secret store. Never put them in a
  page, a repository or a log.
- Sign only in code behind your own sign-in. Take the customer from your session, never from the
  request.
- Send `Cache-Control: no-store` with assertions, and use a short lifetime.

## Checks

```bash
integrations/php-sdk/scripts/test.sh          # PHPUnit, then the Node cross checks
integrations/php-sdk/scripts/test-docker.sh   # PHPUnit in Docker (php:8.3-cli), for a machine without PHP
```

- `tests/fixtures/identity.json` and `webhooks.json` come from `@hamnivo/server`
  (`tests/fixtures/generate.ts`): 35 assertions with every algorithm, the 45 inputs it refuses, and
  34 webhook requests with the decision it took on each. The PHP tests must give the same text and
  the same decisions.
- `tests/fixtures/generate.ts --check` fails when the fixtures no longer match the Node SDK, so a
  change on one side is noticed.
- `tests/cross-check.ts` runs the other way: PHP signs 2,000 ES256 assertions (about one in 128 has
  a leading zero in a number of its signature, which is where conversion bugs hide) and a few of
  every other algorithm, and jose verifies them with the gateway's own options and claims contract.
- Another PHP library (`firebase/php-jwt`) verifies every assertion in the PHPUnit tests too, and
  a fresh process with only `src/autoload.php` shows that the SDK works without Composer.
- The tests ran on PHP 8.4, and on PHP 8.1 (the oldest supported) in WordPress Playground, with
  WordPress's `sodium_compat` supplying EdDSA.

After a change to `@hamnivo/server`, run `pnpm exec tsx integrations/php-sdk/tests/fixtures/generate.ts`
and look at what changed in the fixtures. That change is what the PHP SDK must follow.
