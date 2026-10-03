<?php
/**
 * Where the addon reads WHMCS's data.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Everything the addon reads from WHMCS's database, in four methods. All of it is read only. Tests
 * give the addon an in-memory store, and WHMCS gives it CapsuleStore.
 */
interface Store
{
    /**
     * The addon's settings, by name.
     *
     * @return array<string,string>
     */
    public function settings(): array;

    /** The web address of this WHMCS, as the admin set it under General Settings: SystemURL. */
    public function systemUrl(): string;

    /**
     * A client of this WHMCS, or null.
     *
     * @return array<string,mixed>|null id, firstname, lastname, companyname, email and status.
     */
    public function client(int $id): ?array;

    /**
     * The names of the client's active products, oldest first, without repeats. Only the names of the
     * products as the admin entered them: never a domain, a server, a username, a password or a key.
     *
     * @return list<string>
     */
    public function activeProductNames(int $clientId, int $limit): array;
}
