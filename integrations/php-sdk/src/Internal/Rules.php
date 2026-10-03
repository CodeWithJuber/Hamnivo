<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

/**
 * What the Hamnivo gateway accepts, so input it would refuse fails here with a clear message
 * instead of as a rejected assertion in the customer's browser. It is a port of
 * packages/server-sdk/src/rules.ts. The cross tests in tests/ keep the two in step.
 *
 * @internal
 */
final class Rules
{
    /** Signature algorithms Hamnivo accepts for identity assertions. */
    public const ALGORITHMS = ['ES256', 'EdDSA', 'RS256', 'HS256'];

    /** The key type (and curve) each algorithm that signs with a private key needs. */
    public const KEY_TYPES = [
        'ES256' => ['kty' => 'EC', 'crv' => 'P-256', 'label' => 'an EC P-256'],
        'EdDSA' => ['kty' => 'OKP', 'crv' => 'Ed25519', 'label' => 'an Ed25519'],
        'RS256' => ['kty' => 'RSA', 'crv' => null, 'label' => 'an RSA'],
    ];

    /** Key ids the gateway accepts when a key is registered. */
    public const KID_PATTERN = '/^[A-Za-z0-9._-]{1,64}$/D';

    public const MAX_SUBJECT_LENGTH = 200;
    public const MAX_NAME_LENGTH = 120;

    /** The pattern of Zod 4's `z.email()`, which the gateway's claims contract uses. */
    public const EMAIL_PATTERN = '/^(?:[A-Za-z0-9_\'+-]+\.)*[A-Za-z0-9_\'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/D';

    public const DEFAULT_TTL_SECONDS = 120;
    /** The gateway refuses assertions valid for longer than five minutes. */
    public const MAX_TTL_SECONDS = 300;
    /** Shorter lifetimes expire before the chat can use them (see CLOCK_ALLOWANCE_SECONDS). */
    public const MIN_TTL_SECONDS = 10;

    /**
     * The gateway refuses an assertion issued in the future, even by one second. Dating `iat` a
     * few seconds back keeps assertions valid when this server's clock runs slightly ahead.
     */
    public const CLOCK_ALLOWANCE_SECONDS = 5;

    /** The gateway accepts each `jti` once per brand, so it must never repeat. */
    public const JTI_BYTES = 16;
}
