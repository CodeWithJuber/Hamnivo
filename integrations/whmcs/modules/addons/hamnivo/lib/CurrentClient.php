<?php
/**
 * Who is signed in to the client area right now.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * The client that the signed-in visitor is acting for. It is null for a visitor who is signed out,
 * and also while a staff member is looking at the client area as the client ("Login as Client"):
 * a staff member's browser must never be verified as the customer.
 */
final class CurrentClient
{
    /** User and selected client are separate WHMCS 8 identities; neither comes from request data.
     * @return array{userId:int,clientId:int}|null
     */
    public static function identity(?array $session = null): ?array
    {
        $session = $session ?? (isset($_SESSION) && is_array($_SESSION) ? $_SESSION : []);
        if (!empty($session['adminid']) || !class_exists('WHMCS\\Authentication\\CurrentUser')) {
            return null;
        }
        $current = new \WHMCS\Authentication\CurrentUser();
        $user = method_exists($current, 'user') ? $current->user() : null;
        $client = method_exists($current, 'client') ? $current->client() : null;
        $userId = is_object($user) && isset($user->id) ? (int) $user->id : 0;
        $clientId = is_object($client) && isset($client->id) ? (int) $client->id : 0;
        if ($userId <= 0 || $clientId <= 0) {
            return null;
        }
        return ['userId' => $userId, 'clientId' => $clientId];
    }

    /**
     * @param array<string,mixed>|null $session The PHP session; $_SESSION when null (tests pass their own).
     */
    public static function id(?array $session = null): ?int
    {
        $session = $session ?? (isset($_SESSION) && is_array($_SESSION) ? $_SESSION : []);
        if (!empty($session['adminid'])) {
            return null;
        }
        // WHMCS 8 and later: the client the signed-in user has chosen.
        if (class_exists('WHMCS\\Authentication\\CurrentUser')) {
            $current = new \WHMCS\Authentication\CurrentUser();
            $client = method_exists($current, 'client') ? $current->client() : null;
            $id = is_object($client) && isset($client->id) ? (int) $client->id : 0;

            return $id > 0 ? $id : null;
        }
        $uid = isset($session['uid']) ? (int) $session['uid'] : 0;

        return $uid > 0 ? $uid : null;
    }
}
