<?php
/**
 * Where the addon gets its store. WHMCS gets the database one; tests give it their own.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

final class Services
{
    /** @var Store|null */
    private static $store;

    public static function store(): Store
    {
        if (self::$store === null) {
            self::$store = new CapsuleStore();
        }

        return self::$store;
    }

    /** For tests: use this store from now on, or the database one again with null. */
    public static function useStore(?Store $store): void
    {
        self::$store = $store;
    }
}
