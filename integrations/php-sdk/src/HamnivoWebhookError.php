<?php

declare(strict_types=1);

namespace Hamnivo;

use RuntimeException;

/**
 * A request that is not a valid Hamnivo webhook. Answer it with 400 (or 401), except `duplicate`:
 * that event was already accepted, so answer 2xx and do nothing.
 *
 * `getErrorCode()` is one of the constants below, the same words @hamnivo/server uses.
 */
final class HamnivoWebhookError extends RuntimeException
{
    public const MISSING_HEADER = 'missing_header';
    public const INVALID_TIMESTAMP = 'invalid_timestamp';
    public const TIMESTAMP_OUT_OF_RANGE = 'timestamp_out_of_range';
    public const INVALID_SIGNATURE = 'invalid_signature';
    public const DUPLICATE = 'duplicate';
    public const INVALID_PAYLOAD = 'invalid_payload';

    public function __construct(private readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }
}
