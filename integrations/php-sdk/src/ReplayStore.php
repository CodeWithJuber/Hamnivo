<?php

declare(strict_types=1);

namespace Hamnivo;

/**
 * Remembers webhook ids already accepted, so a request replayed within the tolerance window is
 * refused. PHP forgets everything between requests, so keep the ids somewhere shared: a database
 * table with a unique key, Redis `SET NX EX`, or WordPress transients with an atomic add.
 */
interface ReplayStore
{
    /** Records `$id` for `$ttlSeconds`; false when it is already recorded. Must be atomic. */
    public function claim(string $id, int $ttlSeconds): bool;

    /** Forgets `$id`, so a retry is processed (call it when handling the event failed). */
    public function release(string $id): void;
}
