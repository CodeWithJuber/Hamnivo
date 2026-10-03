<?php
/**
 * The Store that reads WHMCS's database, through the query builder WHMCS gives addons.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

use WHMCS\Database\Capsule;

/**
 * Reads tbladdonmodules, tblconfiguration, tblclients, tblhosting and tblproducts with WHMCS's Capsule. The queries
 * only select, and only the columns the addon needs.
 */
final class CapsuleStore implements Store
{
    public function settings(): array
    {
        $rows = Capsule::table('tbladdonmodules')->where('module', Settings::MODULE)->pluck('value', 'setting');
        $values = is_object($rows) && method_exists($rows, 'all') ? $rows->all() : (array) $rows;

        return array_map('strval', $values);
    }

    public function systemUrl(): string
    {
        $value = Capsule::table('tblconfiguration')->where('setting', 'SystemURL')->value('value');

        return is_scalar($value) ? trim((string) $value) : '';
    }

    public function client(int $id): ?array
    {
        $row = Capsule::table('tblclients')
            ->where('id', $id)
            ->first(['id', 'firstname', 'lastname', 'companyname', 'email', 'status']);

        return $row === null ? null : (array) $row;
    }

    public function activeProductNames(int $clientId, int $limit): array
    {
        $names = Capsule::table('tblhosting')
            ->join('tblproducts', 'tblhosting.packageid', '=', 'tblproducts.id')
            ->where('tblhosting.userid', $clientId)
            ->where('tblhosting.domainstatus', 'Active')
            ->orderBy('tblhosting.id')
            ->pluck('tblproducts.name');
        $list = is_object($names) && method_exists($names, 'all') ? $names->all() : (array) $names;

        $unique = [];
        foreach ($list as $name) {
            $name = trim((string) $name);
            if ($name !== '' && !in_array($name, $unique, true)) {
                $unique[] = $name;
            }
        }

        return array_slice($unique, 0, max(0, $limit));
    }
}
