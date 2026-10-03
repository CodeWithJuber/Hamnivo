<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Hamnivo\Internal\IdentityAssertion;

/**
 * The vectors that tests/fixtures/generate.ts writes from @hamnivo/server, and helpers that make
 * keys and check assertions without the code under test.
 */
final class Fixtures
{
    /** @return array<string, mixed> */
    public static function identity(): array
    {
        static $data = null;

        return $data ??= self::read('identity.json');
    }

    /** @return array<string, mixed> */
    public static function webhooks(): array
    {
        static $data = null;

        return $data ??= self::read('webhooks.json');
    }

    /**
     * Signs a fixture case with the clock and the jti it was made with.
     *
     * @param array<string, mixed> $case
     */
    public static function sign(array $case): string
    {
        return IdentityAssertion::create(
            $case['options'],
            static fn (): int => $case['now'],
            static fn (int $length): string => self::decode($case['jti']),
        );
    }

    public static function decode(string $base64url): string
    {
        return (string) base64_decode(strtr($base64url, '-_', '+/'), true);
    }

    public static function encode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /**
     * Checks an assertion with firebase/php-jwt, an independent implementation, and returns its
     * claims. Throws when the signature or a time claim is wrong.
     *
     * @param array<string, mixed> $key A fixture key: kid and secret, or kid and publicJwk.
     */
    public static function verify(string $jwt, string $alg, array $key, int $at): \stdClass
    {
        JWT::$timestamp = $at;
        try {
            if ($alg === 'HS256') {
                return JWT::decode($jwt, new Key($key['secret'], 'HS256'));
            }
            $jwk = $key['publicJwk'] + ['kid' => $key['kid'], 'alg' => $alg];

            return JWT::decode($jwt, JWK::parseKeySet(['keys' => [$jwk]]));
        } finally {
            JWT::$timestamp = null;
        }
    }

    /**
     * A new key made by PHP, not by the code under test.
     *
     * @return array{privateJwk: array<string, string>, publicJwk: array<string, string>, pem: ?string, key: ?\OpenSSLAsymmetricKey}
     */
    public static function newKey(string $alg): array
    {
        if ($alg === 'EdDSA') {
            if (!self::hasSodium()) {
                throw new \RuntimeException('This PHP has no sodium, which EdDSA needs.');
            }
            $pair = sodium_crypto_sign_keypair();
            $secret = sodium_crypto_sign_secretkey($pair);
            $public = ['kty' => 'OKP', 'crv' => 'Ed25519', 'x' => self::encode(sodium_crypto_sign_publickey($pair))];

            return [
                'privateJwk' => $public + ['d' => self::encode(substr($secret, 0, 32))],
                'publicJwk' => $public,
                'pem' => null,
                'key' => null,
            ];
        }
        $key = $alg === 'ES256'
            ? openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'])
            : openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
        if ($key === false) {
            // Some builds (such as PHP on WebAssembly) cannot generate keys, though they sign.
            throw new \RuntimeException('OpenSSL cannot generate a key here.');
        }
        $details = openssl_pkey_get_details($key);
        openssl_pkey_export($key, $pem);
        if ($alg === 'ES256') {
            $public = ['kty' => 'EC', 'crv' => 'P-256', 'x' => self::encode($details['ec']['x']), 'y' => self::encode($details['ec']['y'])];

            return [
                'privateJwk' => $public + ['d' => self::encode($details['ec']['d'])],
                'publicJwk' => $public,
                'pem' => $pem,
                'key' => $key,
            ];
        }
        $rsa = $details['rsa'];
        $public = ['kty' => 'RSA', 'n' => self::encode($rsa['n']), 'e' => self::encode($rsa['e'])];
        $private = $public + [
            'd' => self::encode($rsa['d']),
            'p' => self::encode($rsa['p']),
            'q' => self::encode($rsa['q']),
            'dp' => self::encode($rsa['dmp1']),
            'dq' => self::encode($rsa['dmq1']),
            'qi' => self::encode($rsa['iqmp']),
        ];

        return ['privateJwk' => $private, 'publicJwk' => $public, 'pem' => $pem, 'key' => $key];
    }

    public static function hasSodium(): bool
    {
        return function_exists('sodium_crypto_sign_detached') && function_exists('sodium_crypto_sign_seed_keypair');
    }

    /** @return array<string, mixed> */
    private static function read(string $name): array
    {
        $text = file_get_contents(__DIR__ . '/fixtures/' . $name);

        return json_decode((string) $text, true, 512, JSON_THROW_ON_ERROR);
    }
}
