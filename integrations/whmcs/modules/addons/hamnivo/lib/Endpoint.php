<?php
/**
 * The address a page asks for an identity assertion: index.php?m=hamnivo&a=identity.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Decides what to answer. It does not print or exit, so it can be tested: hamnivo_clientarea() sends
 * what it returns. Only a signed-in client gets an assertion, and only for themselves.
 */
final class Endpoint
{
    /**
     * @param string               $method   The request method.
     * @param array<string,string> $headers  Request headers, with lower-case names.
     * @param int|null             $clientId The signed-in client, from the session, never from the request.
     * @return array{status:int,headers:array<string,string>,body:string}
     */
    public static function respond(string $method, array $headers, ?int $clientId, Settings $settings, Store $store): array
    {
        if (strtoupper($method) !== 'GET') {
            return self::reply(405, ['error' => 'method_not_allowed'], ['Allow' => 'GET']);
        }
        // Only the page's own script sends this header. A page on another website cannot add it to a
        // request without the browser asking this server first, which it never allows.
        if (($headers['x-requested-with'] ?? '') !== 'XMLHttpRequest') {
            return self::reply(400, ['error' => 'bad_request']);
        }
        $site = $headers['sec-fetch-site'] ?? 'same-origin';
        if ($site !== 'same-origin' && $site !== 'none') {
            return self::reply(403, ['error' => 'forbidden']);
        }
        if ($clientId === null) {
            return self::reply(401, ['error' => 'signed_out']);
        }
        if (!Identity::isReady($settings) || !$settings->isConfigured()) {
            return self::reply(503, ['error' => 'unavailable']);
        }
        $client = $store->client($clientId);
        if ($client === null || ($client['status'] ?? 'Active') === 'Closed') {
            return self::reply(403, ['error' => 'forbidden']);
        }
        $assertion = Identity::assertionFor($client, $settings);
        if ($assertion === null) {
            return self::reply(503, ['error' => 'unavailable']);
        }
        $body = ['assertion' => $assertion];
        $context = Identity::context($store, $clientId, $settings);
        if ($context !== null) {
            $body['context'] = $context;
        }

        return self::reply(200, $body);
    }

    /**
     * @param array<string,mixed>  $body
     * @param array<string,string> $more
     * @return array{status:int,headers:array<string,string>,body:string}
     */
    private static function reply(int $status, array $body, array $more = []): array
    {
        return [
            'status' => $status,
            'headers' => $more + [
                'Content-Type' => 'application/json; charset=utf-8',
                'Cache-Control' => 'no-store, private',
                'X-Content-Type-Options' => 'nosniff',
            ],
            'body' => (string) json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ];
    }
}
