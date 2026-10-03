<?php

declare(strict_types=1);

namespace Hamnivo;

use InvalidArgumentException;
use Throwable;

/**
 * Bad input to createIdentityAssertion(). The message says what to change, and nothing was
 * signed. Messages never repeat the values passed in, so they are safe to log even when a secret
 * was put in the wrong place.
 */
final class HamnivoIdentityError extends InvalidArgumentException
{
    /** @internal */
    public static function invalid(string $message, ?Throwable $previous = null): self
    {
        return new self($message, 0, $previous);
    }
}
