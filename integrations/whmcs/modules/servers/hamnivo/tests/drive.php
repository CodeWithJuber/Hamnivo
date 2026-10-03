<?php
/**
 * Calls one module function the way WHMCS would, for the gateway's integration test:
 *
 *   php drive.php '{"action":"CreateAccount","params":{…}}'
 *
 * Prints {"result": …}.
 */

define('WHMCS', true);
require __DIR__ . '/../hamnivo.php';

const ACTIONS = [
    'TestConnection',
    'CreateAccount',
    'SuspendAccount',
    'UnsuspendAccount',
    'TerminateAccount',
    'ChangePackage',
    'ResendInvitation',
    'AdminServicesTabFields',
    'ClientArea',
];

$input = json_decode($argv[1] ?? '', true);
if (!is_array($input) || !in_array($input['action'] ?? '', ACTIONS, true)) {
    fwrite(STDERR, "usage: php drive.php '{\"action\":\"CreateAccount\",\"params\":{}}'\n");
    exit(2);
}
$function = 'hamnivo_' . $input['action'];
echo json_encode(['result' => $function((array) ($input['params'] ?? []))]);
