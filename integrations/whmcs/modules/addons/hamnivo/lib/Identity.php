<?php
/**
 * Verified clients: signing the identity assertion for the signed-in WHMCS client.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Signs the assertion that tells Hamnivo Chat who the signed-in client is, with the bundled
 * hamnivo/hamnivo-php SDK, which needs PHP 8.1. On older PHP the chat still works and clients stay
 * anonymous. The client always comes from the WHMCS session and database, never from the request.
 */
final class Identity
{
    /** The most product names that are shared. */
    public const MAX_PRODUCTS = 10;

    /**
     * Loads the bundled SDK. False when this PHP is too old or the SDK files are missing.
     */
    public static function sdkAvailable(): bool
    {
        if (PHP_VERSION_ID < 80100) {
            return false;
        }
        if (!function_exists('Hamnivo\\createIdentityAssertion')) {
            $autoload = __DIR__ . '/hamnivo-php/autoload.php';
            if (!is_readable($autoload)) {
                return false;
            }
            require_once $autoload;
        }

        return function_exists('Hamnivo\\createIdentityAssertion');
    }

    /** Why verified clients cannot work here, in words for the admin; null when they can. */
    public static function unavailableReason(): ?string
    {
        if (PHP_VERSION_ID < 80100) {
            return 'Verified clients need PHP 8.1 or newer, and this WHMCS runs PHP ' . PHP_VERSION . '. The chat itself works. Ask your host to move WHMCS to a newer PHP.';
        }
        if (!self::sdkAvailable()) {
            return 'The SDK that signs identities is missing from this copy of the addon. Upload the addon again from the zip file.';
        }

        return null;
    }

    /** Verified clients are on, the key is set and the SDK can sign. */
    public static function isReady(Settings $settings): bool
    {
        return $settings->identityWanted()
            && $settings->keyId() !== ''
            && $settings->hasSecret()
            && self::sdkAvailable();
    }

    /**
     * The key in the form the SDK takes. A secret is HS256. A private key in JSON (a JWK) is ES256,
     * EdDSA or RS256, whichever its type says.
     *
     * @return array<string,mixed>|null Null for JSON that is not a private key Hamnivo accepts.
     */
    public static function key(string $kid, string $secret): ?array
    {
        if (strpos(ltrim($secret), '{') !== 0) {
            return ['kid' => $kid, 'alg' => 'HS256', 'secret' => $secret];
        }
        $jwk = json_decode($secret, true);
        if (!is_array($jwk)) {
            return null;
        }
        $kty = $jwk['kty'] ?? '';
        $crv = $jwk['crv'] ?? '';
        if ($kty === 'EC' && $crv === 'P-256') {
            $alg = 'ES256';
        } elseif ($kty === 'OKP' && $crv === 'Ed25519') {
            $alg = 'EdDSA';
        } elseif ($kty === 'RSA') {
            $alg = 'RS256';
        } else {
            return null;
        }

        return ['kid' => $kid, 'alg' => $alg, 'privateKey' => $jwk];
    }

    /**
     * Signs a test assertion to see whether the key works. The SDK's messages never repeat the key,
     * so they are safe to show.
     *
     * @return string|null What to fix, or null when the key can sign.
     */
    public static function keyProblem(string $kid, string $secret): ?string
    {
        if (!self::sdkAvailable()) {
            return self::unavailableReason();
        }
        $key = self::key($kid, $secret);
        if ($key === null) {
            return 'The key looks like JSON, but it is not a private key that Hamnivo accepts (ES256, EdDSA or RS256). Paste the HS256 secret, or the private key as @hamnivo/server made it.';
        }
        try {
            \Hamnivo\createIdentityAssertion([
                'widgetId' => 'wid_00000000000000000000000000',
                'key' => $key,
                'customer' => ['id' => 'hamnivo-whmcs-test'],
            ]);
        } catch (\Hamnivo\HamnivoIdentityError $error) {
            return $error->getMessage();
        }

        return null;
    }

    /**
     * The customer for a client, from WHMCS's own records. The email is shared only when the admin
     * says that WHMCS makes clients confirm their email, because Hamnivo keeps an email only for a
     * verified one: sending less shares less.
     *
     * @param array<string,mixed> $client A row of the Store: id, firstname, lastname, companyname, email.
     * @return array<string,mixed>
     */
    public static function customerFor(array $client, Settings $settings): array
    {
        $customer = ['id' => (string) $client['id']];

        $name = trim(trim((string) ($client['firstname'] ?? '')) . ' ' . trim((string) ($client['lastname'] ?? '')));
        if ($name === '') {
            $name = trim((string) ($client['companyname'] ?? ''));
        }
        if ($name !== '') {
            $customer['name'] = self::shorten($name, 120);
        }

        $email = trim((string) ($client['email'] ?? ''));
        if ($settings->trustEmails() && $email !== '') {
            $customer['email'] = $email;
            $customer['emailVerified'] = true;
        }

        return $customer;
    }

    /**
     * An assertion for a client, or null when it cannot be signed. Nothing about why leaves here.
     *
     * @param array<string,mixed> $client A row of the Store.
     */
    public static function assertionFor(array $client, Settings $settings): ?string
    {
        if (!self::isReady($settings)) {
            return null;
        }
        $key = self::key($settings->keyId(), $settings->secret());
        if ($key === null) {
            return null;
        }
        $identity = CurrentClient::identity();
        if ($identity === null || $identity['clientId'] !== (int) $client['id']) {
            return null;
        }
        $customer = self::customerFor($client, $settings);
        $customer['id'] = 'whmcs:u:' . $identity['userId'] . ':c:' . $identity['clientId'];
        $options = [
            'widgetId' => $settings->widgetId(),
            'key' => $key,
            'customer' => $customer,
        ];
        try {
            return \Hamnivo\createIdentityAssertion($options);
        } catch (\Hamnivo\HamnivoIdentityError $error) {
            // Hamnivo refuses an address its pattern does not accept. Chat without the email then.
            unset($options['customer']['email'], $options['customer']['emailVerified']);
            try {
                return \Hamnivo\createIdentityAssertion($options);
            } catch (\Hamnivo\HamnivoIdentityError $second) {
                return null;
            }
        }
    }

    /**
     * Read-only context for the chat: the names of the client's active products, when the admin turned
     * that on. Only names, never a domain, a server, a username, a password or a key. The chat treats
     * it as page context from the website, which is not trusted.
     *
     * @return array<string,mixed>|null The page context (see PageContext in @hamnivo/contracts).
     */
    public static function context(Store $store, int $clientId, Settings $settings): ?array
    {
        if (!$settings->shareProducts()) {
            return null;
        }
        $references = [];
        foreach ($store->activeProductNames($clientId, self::MAX_PRODUCTS) as $index => $name) {
            $references['product' . ($index + 1)] = self::shorten((string) $name, 200);
        }
        if ($references === []) {
            return null;
        }

        return ['pageType' => 'client-area', 'references' => $references];
    }

    /**
     * Cuts text to at most this many UTF-16 units, which is how Hamnivo counts, without splitting a
     * character. Text that is not valid UTF-8 is cleaned first.
     */
    public static function shorten(string $text, int $units): string
    {
        if (preg_match('//u', $text) !== 1) {
            $text = (string) iconv('UTF-8', 'UTF-8//IGNORE', $text);
        }
        $characters = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);
        if ($characters === false) {
            return '';
        }
        $kept = '';
        $count = 0;
        foreach ($characters as $character) {
            $count += strlen($character) >= 4 ? 2 : 1;
            if ($count > $units) {
                break;
            }
            $kept .= $character;
        }

        return $kept;
    }
}
