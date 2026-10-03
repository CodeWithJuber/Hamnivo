<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

use Closure;
use DateTimeInterface;
use Hamnivo\HamnivoWebhookError;
use Hamnivo\ReplayStore;
use InvalidArgumentException;
use JsonException;
use Traversable;

/**
 * Verifying Hamnivo webhooks (Standard Webhooks, symmetric `v1` signatures), step for step as
 * packages/server-sdk/src/webhooks.ts does. Every request carries `webhook-id` (the event id, the
 * same on every retry and replay), `webhook-timestamp` (seconds since the epoch, when this attempt
 * was sent) and `webhook-signature` (one or more `v1,<base64 HMAC-SHA256>`, space-separated: two
 * while a secret is being rotated). The HMAC is over `{id}.{timestamp}.{body}`, with the bytes of
 * the secret after its `whsec_` prefix.
 *
 * @internal
 */
final class Webhooks
{
    private const PREFIX = 'whsec_';

    /** `v1,<signature>` of a body, as Hamnivo sends it (for tests of your receiver). */
    public static function sign(string $secret, string $id, int $timestamp, string $body): string
    {
        return 'v1,' . base64_encode(hash_hmac('sha256', self::signedContent($id, (string) $timestamp, $body), self::key($secret), true));
    }

    /**
     * @param iterable<array-key, mixed> $headers
     * @param array<array-key, mixed> $options
     * @return array<string, mixed>
     */
    public static function verify(string $body, iterable $headers, array $options): array
    {
        $headers = $headers instanceof Traversable ? iterator_to_array($headers) : $headers;
        $id = self::header($headers, 'webhook-id');
        $timestamp = self::header($headers, 'webhook-timestamp');
        $signatures = self::header($headers, 'webhook-signature');
        if ($id === null || $timestamp === null || $signatures === null) {
            throw new HamnivoWebhookError(
                HamnivoWebhookError::MISSING_HEADER,
                'The webhook-id, webhook-timestamp and webhook-signature headers are required.',
            );
        }
        if (preg_match('/^\d{1,12}$/D', $timestamp) !== 1) {
            throw new HamnivoWebhookError(HamnivoWebhookError::INVALID_TIMESTAMP, 'webhook-timestamp is not a number.');
        }
        $tolerance = self::tolerance($options['toleranceSeconds'] ?? 300);
        if (abs(self::now($options['now'] ?? null) - (int) $timestamp) > $tolerance) {
            throw new HamnivoWebhookError(
                HamnivoWebhookError::TIMESTAMP_OUT_OF_RANGE,
                'webhook-timestamp is too far from the current time.',
            );
        }

        $content = self::signedContent($id, $timestamp, $body);
        $secrets = self::secrets($options['secret'] ?? null);
        $keys = array_map(self::key(...), $secrets);
        $valid = false;
        foreach (explode(' ', $signatures) as $candidate) {
            $parts = explode(',', $candidate);
            $value = $parts[1] ?? '';
            if ($parts[0] !== 'v1' || $value === '') {
                continue;
            }
            $bytes = self::base64($value);
            if ($bytes === null || strlen($bytes) !== 32) {
                continue;
            }
            foreach ($keys as $key) {
                // hash_equals compares in constant time. No early exit: every key is tried.
                if (hash_equals(hash_hmac('sha256', $content, $key, true), $bytes)) {
                    $valid = true;
                }
            }
        }
        if (!$valid) {
            throw new HamnivoWebhookError(HamnivoWebhookError::INVALID_SIGNATURE, 'No webhook signature matches the secret.');
        }

        $event = self::event($body);
        $store = $options['replayStore'] ?? null;
        if ($store !== null) {
            if (!$store instanceof ReplayStore) {
                throw new InvalidArgumentException('replayStore must implement Hamnivo\\ReplayStore.');
            }
            if (!$store->claim($id, $tolerance * 2)) {
                throw new HamnivoWebhookError(HamnivoWebhookError::DUPLICATE, 'This webhook was already accepted.');
            }
        }

        return $event;
    }

    /** @return array<string, mixed> */
    private static function event(string $body): array
    {
        try {
            $object = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
            $event = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new HamnivoWebhookError(HamnivoWebhookError::INVALID_PAYLOAD, 'The webhook body is not JSON.');
        }
        if (!is_object($object) || !is_array($event)) {
            throw new HamnivoWebhookError(HamnivoWebhookError::INVALID_PAYLOAD, 'The webhook body is not a JSON object.');
        }

        return $event;
    }

    private static function signedContent(string $id, string $timestamp, string $body): string
    {
        return $id . '.' . $timestamp . '.' . $body;
    }

    /** The HMAC key: the bytes of the secret after `whsec_`. */
    private static function key(string $secret): string
    {
        $encoded = str_starts_with($secret, self::PREFIX) ? substr($secret, strlen(self::PREFIX)) : $secret;
        $bytes = self::base64($encoded);
        if ($bytes === null || $bytes === '') {
            throw new InvalidArgumentException('The webhook secret is not a whsec_… value (base64 after the prefix).');
        }

        return $bytes;
    }

    /** @return list<string> */
    private static function secrets(mixed $secret): array
    {
        $secrets = is_string($secret) ? [$secret] : (is_array($secret) ? array_values($secret) : []);
        if ($secrets === []) {
            throw new InvalidArgumentException('Pass the endpoint signing secret.');
        }
        foreach ($secrets as $each) {
            if (!is_string($each)) {
                throw new InvalidArgumentException('The webhook secret must be a string, or a list of strings while rotating.');
            }
        }

        return $secrets;
    }

    private static function tolerance(mixed $value): int
    {
        if (!is_int($value) || $value < 0) {
            throw new InvalidArgumentException('toleranceSeconds must be a whole number of seconds.');
        }

        return $value;
    }

    /** The current time in whole seconds. `$now` may be seconds, a DateTimeInterface or a function giving either. */
    private static function now(mixed $now): int
    {
        if ($now instanceof Closure || (is_callable($now) && !is_string($now))) {
            $now = $now();
        }
        if ($now instanceof DateTimeInterface) {
            return $now->getTimestamp();
        }

        return is_int($now) ? $now : time();
    }

    /** Forgiving base64 like `atob`: white space is ignored and padding may be left out. */
    private static function base64(string $text): ?string
    {
        $bytes = base64_decode($text, true);

        return $bytes === false ? null : $bytes;
    }

    /**
     * One header's value, found without regard to case. It works with the arrays PHP, WordPress and
     * PSR-7 give: `getallheaders()`, `$request->get_headers()`, `$message->getHeaders()`, and
     * `$_SERVER` (`HTTP_WEBHOOK_ID`).
     *
     * @param iterable<array-key, mixed> $headers
     */
    private static function header(iterable $headers, string $name): ?string
    {
        foreach ($headers as $key => $value) {
            $key = (string) $key;
            if (str_starts_with($key, 'HTTP_')) {
                $key = substr($key, 5);
            }
            if (strtolower(str_replace('_', '-', $key)) !== $name) {
                continue;
            }
            if (is_array($value)) {
                $value = $value[array_key_first($value)] ?? null;
            }

            return is_string($value) && $value !== '' ? $value : null;
        }

        return null;
    }
}
