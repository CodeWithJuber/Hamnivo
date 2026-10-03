<?php
/**
 * The "Test connection" button on the addon's admin page.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Asks the chat address for its loader and the API for the widget, the way a visitor's browser
 * would, and says in plain words what is wrong. It only reads. Nothing is created in Hamnivo.
 */
final class ConnectionTest
{
    /**
     * @param callable $http fn (string $url, array<string,string> $headers): array{status:int,body:string};
     *                       throws RuntimeException when the address cannot be reached. Tests pass their own.
     * @return array{ok:bool,checks:list<array{ok:bool,label:string,detail:string}>}
     */
    public static function run(Settings $settings, string $systemUrl, callable $http): array
    {
        $checks = [
            self::checkWidgetId($settings),
            self::checkChat($settings, $systemUrl, $http),
            self::checkApi($settings, $systemUrl, $http),
        ];
        if ($settings->identityWanted()) {
            $checks[] = self::checkIdentity($settings);
        }
        $ok = true;
        foreach ($checks as $check) {
            $ok = $ok && $check['ok'];
        }

        return ['ok' => $ok, 'checks' => $checks];
    }

    /** The origin a visitor's browser sends from this WHMCS: its scheme, host and port. */
    public static function origin(string $systemUrl): string
    {
        $parts = parse_url($systemUrl);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return '';
        }

        return strtolower($parts['scheme']) . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    }

    /** A GET request with cURL: http and https only, a few redirects, a short wait. */
    public static function curl(string $url, array $headers): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('PHP has no cURL here.');
        }
        $handle = curl_init($url);
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_USERAGENT => 'HamnivoChat-WHMCS/' . Output::VERSION,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        ]);
        $body = curl_exec($handle);
        if ($body === false) {
            $message = curl_error($handle);
            curl_close($handle);
            throw new \RuntimeException($message !== '' ? $message : 'The request failed.');
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        return ['status' => $status, 'body' => (string) $body];
    }

    private static function checkWidgetId(Settings $settings): array
    {
        if ($settings->widgetId() === '') {
            return self::fail('Widget ID', 'Enter the widget ID. It is wid_ followed by 26 lowercase letters and digits.');
        }

        return self::pass('Widget ID', 'The widget ID has the right shape.');
    }

    private static function checkChat(Settings $settings, string $systemUrl, callable $http): array
    {
        $label = 'Chat address';
        if ($settings->chatUrl() === '') {
            return self::fail($label, 'Enter the chat address, for example https://chat.example.com.');
        }
        if (strpos($settings->chatUrl(), 'http://') === 0 && strpos($systemUrl, 'https://') === 0) {
            return self::fail($label, 'The chat address starts with http://, but WHMCS uses https://. Browsers block the chat then. Use the https:// address.');
        }
        try {
            $response = $http($settings->chatUrl() . '/loader.js', []);
        } catch (\RuntimeException $error) {
            return self::fail($label, 'WHMCS could not reach the chat address. ' . $error->getMessage());
        }
        if ($response['status'] !== 200) {
            return self::fail($label, 'The chat address answered with status ' . $response['status'] . ' instead of the loader. Check the address.');
        }
        if (strpos($response['body'], 'Hamnivo') === false) {
            return self::fail($label, 'The address answered, but what it sent is not the Hamnivo loader. Check the address.');
        }

        return self::pass($label, 'The chat address serves the loader.');
    }

    private static function checkApi(Settings $settings, string $systemUrl, callable $http): array
    {
        $label = 'API address and allowed website';
        if ($settings->apiUrl() === '') {
            return self::pass($label, 'No API address is set, so the chat uses its own default. Nothing to check here.');
        }
        if ($settings->widgetId() === '') {
            return self::fail($label, 'Enter a valid widget ID first.');
        }
        if (strpos($settings->apiUrl(), 'http://') === 0 && strpos($systemUrl, 'https://') === 0) {
            return self::fail($label, 'The API address starts with http://, but WHMCS uses https://. Browsers block it then. Use the https:// address.');
        }
        $origin = self::origin($systemUrl);
        try {
            $response = $http(
                $settings->apiUrl() . '/v1/widget/launcher?widgetId=' . rawurlencode($settings->widgetId()),
                ['Origin' => $origin, 'Accept' => 'application/json']
            );
        } catch (\RuntimeException $error) {
            return self::fail($label, 'WHMCS could not reach the API address. ' . $error->getMessage());
        }
        $body = json_decode($response['body'], true);
        $body = is_array($body) ? $body : [];
        if ($response['status'] === 200 && ($body['widgetId'] ?? null) === $settings->widgetId()) {
            return self::pass($label, 'Hamnivo knows this widget ID and allows ' . $origin . ' to use it.');
        }
        if ($response['status'] === 403 && ($body['code'] ?? null) === 'ORIGIN_NOT_ALLOWED') {
            return self::fail($label, 'Hamnivo knows this widget ID, but ' . $origin . " is not in the brand's allowed websites. In Hamnivo Studio, open the brand and add this address to its allowed websites. The chat opens only there.");
        }
        if ($response['status'] === 404) {
            return self::fail($label, 'Hamnivo does not know this widget ID, or the brand is not active. Check the widget ID, and that the API address belongs to the same Hamnivo as the chat address.');
        }

        return self::fail($label, 'The API answered with status ' . $response['status'] . '. Check the API address.');
    }

    /** Whether the identity key can sign. It is checked here, on this server, so nothing is sent. */
    private static function checkIdentity(Settings $settings): array
    {
        $label = 'Verified clients';
        if ($settings->keyId() === '' || !$settings->hasSecret()) {
            return self::fail($label, 'Verified clients are on, but the key ID or the key is empty.');
        }
        $problem = Identity::keyProblem($settings->keyId(), $settings->secret());
        if ($problem !== null) {
            return self::fail($label, $problem);
        }

        return self::pass($label, 'The key works. Signed-in clients will be verified.');
    }

    private static function pass(string $label, string $detail): array
    {
        return ['ok' => true, 'label' => $label, 'detail' => $detail];
    }

    private static function fail(string $label, string $detail): array
    {
        return ['ok' => false, 'label' => $label, 'detail' => $detail];
    }
}
