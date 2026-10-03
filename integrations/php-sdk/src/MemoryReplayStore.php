<?php

declare(strict_types=1);

namespace Hamnivo;

use Closure;

/**
 * A replay store that lives in memory. It is useful for tests and for long-running PHP (Swoole,
 * RoadRunner, a queue worker). Ordinary PHP requests do not share memory, so use a shared store
 * there. Entries expire; at most `$maxEntries` are kept.
 */
final class MemoryReplayStore implements ReplayStore
{
    /** @var array<string, int> Expiry in milliseconds, oldest first. */
    private array $seen = [];

    /** @var Closure(): int */
    private readonly Closure $now;

    /**
     * @param (callable(): int)|null $now The current time in milliseconds (tests).
     */
    public function __construct(private readonly int $maxEntries = 100_000, ?callable $now = null)
    {
        $this->now = $now === null
            ? static fn (): int => (int) (microtime(true) * 1000)
            : Closure::fromCallable($now);
    }

    public function claim(string $id, int $ttlSeconds): bool
    {
        $now = ($this->now)();
        foreach ($this->seen as $key => $expires) {
            if ($expires > $now) {
                break;
            }
            unset($this->seen[$key]);
        }
        $expires = $this->seen[$id] ?? null;
        if ($expires !== null && $expires > $now) {
            return false;
        }
        unset($this->seen[$id]);
        $this->seen[$id] = $now + $ttlSeconds * 1000;
        while (count($this->seen) > $this->maxEntries) {
            $oldest = array_key_first($this->seen);
            if ($oldest === null) {
                break;
            }
            unset($this->seen[$oldest]);
        }

        return true;
    }

    public function release(string $id): void
    {
        unset($this->seen[$id]);
    }
}
