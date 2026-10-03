<?php

/**
 * The SDK's functions, named as in @hamnivo/server. Composer loads this file by itself; without
 * Composer, `require` autoload.php, which loads it too.
 */

declare(strict_types=1);

namespace Hamnivo;

use Hamnivo\Internal\IdentityAssertion;
use Hamnivo\Internal\Webhooks;

// Each function is declared only once, so two plugins that bundle this SDK can live together.
if (!function_exists(__NAMESPACE__ . '\\createIdentityAssertion')) {
    /**
     * Signs a short-lived identity assertion (a compact JWS) for a signed-in customer. Send it to
     * the page, which passes it to `Hamnivo.identify(assertion)`. Sign a new one for every call:
     * Hamnivo accepts each assertion once.
     *
     * The result is the same as `createIdentityAssertion` of @hamnivo/server for the same input,
     * apart from what changes on every call (`iat`, `jti`) and, with ES256, the signature itself.
     *
     * Options, as in the Node SDK:
     *
     * - `widgetId`: the brand's widget ID (`wid_…`). It becomes `aud`.
     * - `key`: the key registered for the brand in Hamnivo.
     *   - `kid`: the key id. It goes in the `kid` header.
     *   - `alg`: `ES256`, `EdDSA`, `RS256` or `HS256`.
     *   - `secret`: HS256 only. The secret Hamnivo showed once, exactly as shown.
     *   - `privateKey`: the other algorithms. A JWK as an array or as JSON text. ES256 and RS256
     *     also take a PEM private key or an OpenSSLAsymmetricKey.
     * - `customer`: the signed-in customer, taken from your own records. Never copy these from
     *   the request.
     *   - `id`: your stable id for the account, 1 to 200 characters. It becomes `sub`.
     *   - `name`: at most 120 characters.
     *   - `email`: an address Hamnivo accepts.
     *   - `emailVerified`: true only when your website has confirmed the address. Hamnivo keeps
     *     the email only then.
     * - `ttlSeconds`: seconds from `iat` to `exp`. 120 by default, at most 300 (larger values are
     *   capped), at least 10.
     *
     * @param array{
     *     widgetId: string,
     *     key: array{kid: string, alg: string, secret?: string, privateKey?: array<string, mixed>|string|\OpenSSLAsymmetricKey},
     *     customer: array{id: string|int, name?: string|null, email?: string|null, emailVerified?: bool|null},
     *     ttlSeconds?: int
     * } $options
     * @throws HamnivoIdentityError When the input is something Hamnivo would refuse. Nothing is signed.
     */
    function createIdentityAssertion(array $options): string
    {
        return IdentityAssertion::create($options);
    }
}

if (!function_exists(__NAMESPACE__ . '\\verifyWebhook')) {
    /**
     * Checks a webhook request and returns its event as an array. Pass the body exactly as
     * received (the raw text, before any JSON decoding) and the request headers: the array of
     * `getallheaders()`, `$request->get_headers()` in WordPress, `$_SERVER`, or the headers of a
     * PSR-7 message. Names are matched without regard to case.
     *
     * Options:
     *
     * - `secret`: the endpoint's `whsec_…` signing secret, or both secrets (a list) while rotating.
     * - `toleranceSeconds`: how far `webhook-timestamp` may be from now. 300 by default.
     * - `replayStore`: a Hamnivo\ReplayStore that refuses an id seen before.
     * - `now`: the current time, as seconds, a DateTimeInterface or a function giving either (tests).
     *
     * @param iterable<array-key, mixed> $headers
     * @param array{
     *     secret: string|list<string>,
     *     toleranceSeconds?: int,
     *     replayStore?: ReplayStore|null,
     *     now?: int|\DateTimeInterface|callable(): (int|\DateTimeInterface)|null
     * } $options
     * @return array<string, mixed> The event: `id`, `type`, `timestamp`, `schemaVersion`, `tenantId`, `data`.
     * @throws HamnivoWebhookError When the request is not a valid Hamnivo webhook. `duplicate` means
     *     it was accepted before: answer 2xx and do nothing.
     * @throws \InvalidArgumentException When the secret is missing or is not a whsec_… value.
     */
    function verifyWebhook(string $body, iterable $headers, array $options): array
    {
        return Webhooks::verify($body, $headers, $options);
    }
}

if (!function_exists(__NAMESPACE__ . '\\signWebhook')) {
    /**
     * `v1,<signature>` of a body, as Hamnivo sends it. Use it in tests of your receiver.
     */
    function signWebhook(string $secret, string $id, int $timestamp, string $body): string
    {
        return Webhooks::sign($secret, $id, $timestamp, $body);
    }
}
