<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

use Closure;
use Hamnivo\HamnivoIdentityError;
use OpenSSLAsymmetricKey;

/**
 * The key that signs assertions, checked once and ready to sign: HS256 with the secret, ES256 and
 * RS256 with OpenSSL, EdDSA with libsodium. It is a port of `signingKeyFor` in
 * packages/server-sdk/src/assertion.ts, and refuses what that refuses.
 *
 * @internal
 */
final class SigningKey
{
    /** @param Closure(string): string $signer Signs the signing input, returns the raw signature. */
    private function __construct(
        public readonly string $kid,
        public readonly string $alg,
        private readonly Closure $signer,
    ) {
    }

    public function sign(string $signingInput): string
    {
        return ($this->signer)($signingInput);
    }

    /** @param mixed $key The `key` option: ['kid' => …, 'alg' => …, 'privateKey' => … or 'secret' => …]. */
    public static function from(mixed $key): self
    {
        if (!is_array($key)) {
            throw self::invalid("key is required: ['kid' => …, 'alg' => …, 'privateKey' => …], or ['kid' => …, 'alg' => 'HS256', 'secret' => …].");
        }
        $kid = $key['kid'] ?? null;
        $alg = $key['alg'] ?? null;
        $privateKey = $key['privateKey'] ?? null;
        $secret = $key['secret'] ?? null;

        if (!is_string($kid) || preg_match(Rules::KID_PATTERN, $kid) !== 1) {
            throw self::invalid('key.kid must be the key id registered with Hamnivo: 1 to 64 letters, digits, dots, underscores or dashes.');
        }
        if (!is_string($alg) || !in_array($alg, Rules::ALGORITHMS, true)) {
            throw self::invalid('key.alg must be ES256, EdDSA, RS256 or HS256.');
        }
        if ($alg === 'HS256') {
            return new self($kid, $alg, self::hmac($privateKey, $secret));
        }
        if ($secret !== null) {
            throw self::invalid("{$alg} signs with key.privateKey. key.secret is for HS256 only.");
        }
        if ($privateKey === null) {
            throw self::invalid("{$alg} needs key.privateKey: the private key whose public key you registered.");
        }

        return new self($kid, $alg, self::asymmetric($alg, $privateKey));
    }

    /** @return Closure(string): string */
    private static function hmac(mixed $privateKey, mixed $secret): Closure
    {
        if ($privateKey !== null) {
            throw self::invalid('HS256 signs with key.secret. key.privateKey is for ES256, EdDSA and RS256.');
        }
        if (!is_string($secret) || $secret === '') {
            throw self::invalid('HS256 needs key.secret: the secret Hamnivo showed when you registered the key.');
        }
        if (!Text::isUtf8($secret)) {
            throw self::invalid('key.secret must be text, exactly as Hamnivo showed it.');
        }
        if (Text::hasSpace($secret)) {
            throw self::invalid('key.secret contains spaces or line breaks. Use it exactly as Hamnivo showed it.');
        }

        // The gateway uses the characters of the secret as the HMAC key. It is not base64-decoded.
        return static fn (string $input): string => hash_hmac('sha256', $input, $secret, true);
    }

    /** @return Closure(string): string */
    private static function asymmetric(string $alg, mixed $privateKey): Closure
    {
        if (is_string($privateKey)) {
            $privateKey = self::fromText($privateKey);
        }
        if ($privateKey instanceof OpenSSLAsymmetricKey) {
            return self::fromOpenSsl($alg, $privateKey);
        }
        if (!is_array($privateKey)) {
            throw self::invalid('key.privateKey must be a JWK (an array, or its JSON text), a PEM private key, or an OpenSSLAsymmetricKey.');
        }

        return self::fromJwk($alg, $privateKey);
    }

    /** Text is a JWK in JSON, or a PEM private key. */
    private static function fromText(string $text): array|OpenSSLAsymmetricKey
    {
        $trimmed = trim($text);
        if (str_starts_with($trimmed, '{')) {
            $jwk = json_decode($trimmed, true);
            if (!is_array($jwk)) {
                throw self::invalid('key.privateKey is text that looks like JSON, but it is not a valid JWK.');
            }

            return $jwk;
        }
        if (str_starts_with($trimmed, '-----BEGIN')) {
            $key = openssl_pkey_get_private($trimmed);
            self::drainOpenSslErrors();
            if ($key === false) {
                throw self::invalid('OpenSSL could not read key.privateKey. Use a PEM private key without a passphrase.');
            }

            return $key;
        }
        throw self::invalid('key.privateKey must be a JWK (an array, or its JSON text), a PEM private key, or an OpenSSLAsymmetricKey.');
    }

    /** @param array<array-key, mixed> $jwk */
    private static function fromJwk(string $alg, array $jwk): Closure
    {
        $expected = Rules::KEY_TYPES[$alg];
        if (($jwk['kty'] ?? null) !== $expected['kty'] || ($expected['crv'] !== null && ($jwk['crv'] ?? null) !== $expected['crv'])) {
            throw self::invalid("{$alg} needs {$expected['label']} private key, and key.privateKey is another kind of key. Check that key.alg matches the key.");
        }
        if (!isset($jwk['d']) || !is_string($jwk['d'])) {
            throw self::invalid('key.privateKey is a public key. Sign with the private key (the JWK with "d").');
        }
        if (isset($jwk['alg']) && $jwk['alg'] !== $alg) {
            throw self::invalid("key.privateKey is marked for another algorithm than {$alg}.");
        }

        return match ($alg) {
            'ES256' => self::fromOpenSsl($alg, self::ecKey($jwk)),
            'RS256' => self::fromOpenSsl($alg, self::rsaKey($jwk)),
            default => self::ed25519($jwk),
        };
    }

    /** @param array<array-key, mixed> $jwk */
    private static function ecKey(array $jwk): OpenSSLAsymmetricKey
    {
        $d = self::member($jwk, 'd');
        $x = self::member($jwk, 'x');
        $y = self::member($jwk, 'y');
        if ($d === null || strlen($d) !== 32) {
            throw self::cannotSign('ES256', 'the private value (d) is not 32 bytes of base64url.');
        }
        $hasPoint = $x !== null && $y !== null && strlen($x) === 32 && strlen($y) === 32;

        return self::readPem('ES256', Der::pem('EC PRIVATE KEY', Der::p256PrivateKey($d, $hasPoint ? $x : null, $hasPoint ? $y : null)));
    }

    /** @param array<array-key, mixed> $jwk */
    private static function rsaKey(array $jwk): OpenSSLAsymmetricKey
    {
        $parts = [];
        foreach (['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] as $name) {
            $parts[$name] = self::member($jwk, $name);
            if ($parts[$name] === null) {
                throw self::cannotSign('RS256', "the JWK has no usable \"{$name}\" member.");
            }
        }
        if (self::bitLength($parts['n'] ?? '') < 2048) {
            throw self::cannotSign('RS256', 'RS256 requires key modulusLength to be 2048 bits or larger');
        }

        return self::readPem('RS256', Der::pem('RSA PRIVATE KEY', Der::rsaPrivateKey(
            $parts['n'] ?? '',
            $parts['e'] ?? '',
            $parts['d'] ?? '',
            $parts['p'] ?? '',
            $parts['q'] ?? '',
            $parts['dp'] ?? '',
            $parts['dq'] ?? '',
            $parts['qi'] ?? '',
        )));
    }

    /** @param array<array-key, mixed> $jwk */
    private static function ed25519(array $jwk): Closure
    {
        foreach (['sodium_crypto_sign_seed_keypair', 'sodium_crypto_sign_secretkey', 'sodium_crypto_sign_detached'] as $function) {
            if (!function_exists($function)) {
                throw self::invalid('EdDSA needs the PHP sodium extension, or the sodium_compat library that WordPress includes. Neither is available here.');
            }
        }
        $seed = self::member($jwk, 'd');
        if ($seed === null || strlen($seed) !== 32) {
            throw self::cannotSign('EdDSA', 'the private value (d) is not 32 bytes of base64url.');
        }
        $secretKey = sodium_crypto_sign_secretkey(sodium_crypto_sign_seed_keypair($seed));

        return static fn (string $input): string => sodium_crypto_sign_detached($input, $secretKey);
    }

    /** ES256 and RS256 sign with OpenSSL; the key comes from a JWK, a PEM file or the caller. */
    private static function fromOpenSsl(string $alg, OpenSSLAsymmetricKey $key): Closure
    {
        $details = openssl_pkey_get_details($key);
        if ($details === false) {
            self::drainOpenSslErrors();
            throw self::cannotSign($alg, 'OpenSSL could not read the key.');
        }
        $type = $details['type'] ?? null;
        $isEc = $type === OPENSSL_KEYTYPE_EC && ($details['ec']['curve_name'] ?? null) === 'prime256v1';
        $isRsa = $type === OPENSSL_KEYTYPE_RSA;
        if (($alg === 'ES256' && !$isEc) || ($alg === 'RS256' && !$isRsa) || $alg === 'EdDSA') {
            throw self::invalid($alg === 'EdDSA'
                ? 'EdDSA needs key.privateKey as a JWK (an array, or its JSON text).'
                : "{$alg} needs " . Rules::KEY_TYPES[$alg]['label'] . ' private key, and key.privateKey is another kind of key. Check that key.alg matches the key.');
        }
        if (!isset($details[$isEc ? 'ec' : 'rsa']['d'])) {
            throw self::invalid('key.privateKey is a public key. Sign with the private key (the JWK with "d").');
        }
        if ($isRsa && ($details['bits'] ?? 0) < 2048) {
            throw self::cannotSign($alg, 'RS256 requires key modulusLength to be 2048 bits or larger');
        }

        return static function (string $input) use ($alg, $key): string {
            $der = '';
            if (!openssl_sign($input, $der, $key, OPENSSL_ALGO_SHA256)) {
                self::drainOpenSslErrors();
                throw self::cannotSign($alg, 'OpenSSL could not sign.');
            }
            if ($alg === 'RS256') {
                return $der;
            }
            $raw = Der::ecdsaToJose($der, 32);
            if ($raw === null) {
                throw self::cannotSign($alg, 'OpenSSL made a signature that is not ES256.');
            }

            return $raw;
        };
    }

    private static function readPem(string $alg, string $pem): OpenSSLAsymmetricKey
    {
        $key = openssl_pkey_get_private($pem);
        if ($key === false) {
            self::drainOpenSslErrors();
            throw self::cannotSign($alg, 'OpenSSL could not read the key.');
        }

        return $key;
    }

    /**
     * The bytes of a JWK member written in base64url; null when it is missing or not base64url.
     *
     * @param array<array-key, mixed> $jwk
     */
    private static function member(array $jwk, string $name): ?string
    {
        $value = $jwk[$name] ?? null;

        return is_string($value) ? Base64Url::decode($value) : null;
    }

    /** The size of an unsigned big-endian number in bits, as WebCrypto's `modulusLength`. */
    private static function bitLength(string $bytes): int
    {
        $bytes = ltrim($bytes, "\x00");
        if ($bytes === '') {
            return 0;
        }
        $bits = (strlen($bytes) - 1) * 8;
        for ($top = ord($bytes[0]); $top > 0; $top >>= 1) {
            $bits++;
        }

        return $bits;
    }

    private static function drainOpenSslErrors(): void
    {
        while (openssl_error_string() !== false) {
            // OpenSSL queues its messages; read them all so they do not show up in later calls.
        }
    }

    private static function cannotSign(string $alg, string $reason): HamnivoIdentityError
    {
        return self::invalid("key.privateKey cannot sign {$alg}: {$reason}");
    }

    private static function invalid(string $message): HamnivoIdentityError
    {
        return HamnivoIdentityError::invalid($message);
    }
}
