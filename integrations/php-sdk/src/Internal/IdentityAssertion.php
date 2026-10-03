<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

use Closure;
use Hamnivo\HamnivoIdentityError;
use JsonException;

/**
 * Signs a short-lived identity assertion, a compact JWS, byte for byte as `createIdentityAssertion`
 * of @hamnivo/server does: the same header, the same claims in the same order, the same JSON text.
 * See packages/server-sdk/src/assertion.ts.
 *
 * @internal
 */
final class IdentityAssertion
{
    /**
     * @param array<array-key, mixed> $options See \Hamnivo\createIdentityAssertion().
     * @param (callable(): int)|null $clock The time in seconds since the epoch (tests).
     * @param (callable(int): string)|null $randomBytes Random bytes of the given length (tests).
     */
    public static function create(array $options, ?callable $clock = null, ?callable $randomBytes = null): string
    {
        $widgetId = $options['widgetId'] ?? null;
        if (!is_string($widgetId) || !str_starts_with($widgetId, 'wid_')) {
            throw self::invalid("widgetId must be the brand's widget ID, which starts with wid_.");
        }
        $key = SigningKey::from($options['key'] ?? null);
        $claims = self::customerClaims($options['customer'] ?? null);
        $ttl = self::lifetime($options['ttlSeconds'] ?? Rules::DEFAULT_TTL_SECONDS);

        $now = $clock === null ? time() : $clock();
        $iat = $now - Rules::CLOCK_ALLOWANCE_SECONDS;
        $random = $randomBytes === null ? random_bytes(...) : Closure::fromCallable($randomBytes);
        $jti = Base64Url::encode($random(Rules::JTI_BYTES));

        $sub = $claims['sub'];
        unset($claims['sub']);
        $payload = ['sub' => $sub, 'aud' => $widgetId, 'iat' => $iat, 'exp' => $iat + $ttl, 'jti' => $jti] + $claims;
        $header = ['alg' => $key->alg, 'kid' => $key->kid, 'typ' => 'JWT'];

        $signingInput = Base64Url::encode(self::json($header)) . '.' . Base64Url::encode(self::json($payload));

        return $signingInput . '.' . Base64Url::encode($key->sign($signingInput));
    }

    /**
     * @return array{sub: string, name?: string, email?: string, email_verified?: bool}
     */
    private static function customerClaims(mixed $customer): array
    {
        if (!is_array($customer)) {
            throw self::invalid("customer is required: ['id' => …, 'name' => …, 'email' => …, 'emailVerified' => …].");
        }
        $id = $customer['id'] ?? null;
        if (is_int($id)) {
            $id = (string) $id;
        }
        if (!is_string($id)) {
            throw self::invalid('customer.id must be a string. Convert a number with (string) $id.');
        }
        self::requireUtf8($id, 'customer.id');
        if (Text::isBlank($id)) {
            throw self::invalid('customer.id is empty. Use your stable id for this customer account.');
        }
        if (Text::length($id) > Rules::MAX_SUBJECT_LENGTH) {
            throw self::invalid('customer.id is longer than ' . Rules::MAX_SUBJECT_LENGTH . ' characters.');
        }
        $claims = ['sub' => $id];

        $name = $customer['name'] ?? null;
        if ($name !== null) {
            if (!is_string($name)) {
                throw self::invalid('customer.name must be a string.');
            }
            self::requireUtf8($name, 'customer.name');
            if (Text::length($name) > Rules::MAX_NAME_LENGTH) {
                throw self::invalid('customer.name is longer than ' . Rules::MAX_NAME_LENGTH . ' characters.');
            }
            $claims['name'] = $name;
        }

        $email = $customer['email'] ?? null;
        if ($email !== null) {
            if (!is_string($email) || preg_match(Rules::EMAIL_PATTERN, $email) !== 1) {
                throw self::invalid('customer.email is not an address Hamnivo accepts. Correct it or leave it out.');
            }
            $claims['email'] = $email;
        }

        $verified = $customer['emailVerified'] ?? null;
        if ($verified !== null) {
            if (!is_bool($verified)) {
                throw self::invalid('customer.emailVerified must be true or false.');
            }
            $claims['email_verified'] = $verified;
        }

        return $claims;
    }

    private static function lifetime(mixed $ttlSeconds): int
    {
        if (!is_int($ttlSeconds) || $ttlSeconds < Rules::MIN_TTL_SECONDS) {
            throw self::invalid('ttlSeconds must be a whole number of seconds, at least ' . Rules::MIN_TTL_SECONDS . '.');
        }

        return min($ttlSeconds, Rules::MAX_TTL_SECONDS);
    }

    /** JSON text the way JavaScript's `JSON.stringify` writes it: no spaces, no escaped slashes or letters. */
    private static function json(array $value): string
    {
        try {
            return json_encode(
                $value,
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS,
            );
        } catch (JsonException $e) {
            throw HamnivoIdentityError::invalid('The assertion could not be written as JSON.', $e);
        }
    }

    private static function requireUtf8(string $text, string $field): void
    {
        if (!Text::isUtf8($text)) {
            throw self::invalid("{$field} must be valid UTF-8 text.");
        }
    }

    private static function invalid(string $message): HamnivoIdentityError
    {
        return HamnivoIdentityError::invalid($message);
    }
}
