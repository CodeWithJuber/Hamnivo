<?php
/**
 * Tests of the Hamnivo WHMCS module against a stand-in operator API (no WHMCS needed):
 *
 *   php integrations/whmcs/modules/servers/hamnivo/tests/run.php
 *
 * Each module function is called with the parameters WHMCS passes, and the requests the stand-in
 * received are checked: method, path, key and body.
 */

define('WHMCS', true);

$logged = [];
function logModuleCall($module, $action, $request, $response, $processed, $replace)
{
    global $logged;
    $logged[] = compact('module', 'action', 'request', 'response', 'replace');
}

require __DIR__ . '/../hamnivo.php';

const KEY = 'hvop_0123456789ab_TestKeyTestKeyTestKeyTestKeyTestKeyTest123';

$log = tempnam(sys_get_temp_dir(), 'hamnivo-mock-');
$socket = stream_socket_server('tcp://127.0.0.1:0');
$port = (int) substr(strrchr(stream_socket_get_name($socket, false), ':'), 1);
fclose($socket);
$server = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/mock-operator-api.php'],
    [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    null,
    ['HAMNIVO_MOCK_LOG' => $log]
);
register_shutdown_function(function () use ($server, $log) {
    proc_terminate($server);
    @unlink($log);
});
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100000);
}

$failures = 0;
$checks = 0;
function check(bool $ok, string $what): void
{
    global $failures, $checks;
    $checks++;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL: $what\n");
    }
}

/** Requests the stand-in received since the last call. */
function requests(): array
{
    global $log;
    $lines = array_filter(explode("\n", (string) file_get_contents($log)));
    file_put_contents($log, '');
    return array_map(function ($line) {
        return json_decode($line, true);
    }, array_values($lines));
}

$params = [
    'serverhostname' => "127.0.0.1:$port",
    'serversecure' => '',
    'serverpassword' => KEY,
    'serviceid' => 42,
    'domain' => 'acme.example',
    'clientsdetails' => [
        'firstname' => 'Olivia',
        'lastname' => 'Owner',
        'email' => 'olivia@acme.example',
        'companyname' => 'Acme Ltd',
    ],
    'configoption1' => 'pro',
    'configoption2' => 'on',
    'configoption3' => 'ar',
    'configoption4' => 'on',
];

// Test Connection: the ping, with the key as a bearer token.
$test = hamnivo_TestConnection($params);
check($test === ['success' => true, 'error' => ''], 'TestConnection succeeds: ' . json_encode($test));
[$ping] = requests();
check($ping['method'] === 'GET' && $ping['path'] === '/v1/operator/ping', 'TestConnection pings');
check($ping['auth'] === 'Bearer ' . KEY, 'the key goes in the Authorization header');

// CreateAccount: the workspace, its owner, plan, trial, language and first brand.
check(hamnivo_CreateAccount($params) === 'success', 'CreateAccount succeeds');
[$create] = requests();
check($create['method'] === 'POST' && $create['path'] === '/v1/operator/accounts', 'CreateAccount posts to accounts');
check($create['body'] === [
    'externalRef' => 'whmcs:42',
    'name' => 'Acme Ltd',
    'defaultLocale' => 'ar',
    'owner' => ['email' => 'olivia@acme.example', 'name' => 'Olivia Owner'],
    'startTrial' => true,
    'planKey' => 'pro',
    'brand' => ['name' => 'Acme Ltd', 'website' => 'https://acme.example'],
], 'CreateAccount sends the order: ' . json_encode($create['body']));

// Without a company, plan or brand: the client's name and the server's default plan.
$plain = $params;
$plain['clientsdetails']['companyname'] = '';
$plain['configoption1'] = '';
$plain['configoption2'] = '';
$plain['configoption4'] = '';
check(hamnivo_CreateAccount($plain) === 'success', 'CreateAccount without options succeeds');
[$created] = requests();
check($created['body']['name'] === 'Olivia Owner', 'the workspace is named after the client');
check(!isset($created['body']['planKey']) && !isset($created['body']['brand']), 'no plan or brand unless set');
check($created['body']['startTrial'] === false, 'no trial unless set');

// Suspend, unsuspend and terminate the workspace named by the service.
$suspend = $params + ['suspendreason' => 'Overdue on invoice 1234'];
check(hamnivo_SuspendAccount($suspend) === 'success', 'SuspendAccount succeeds');
check(hamnivo_UnsuspendAccount($params) === 'success', 'UnsuspendAccount succeeds');
check(hamnivo_TerminateAccount($params) === 'success', 'TerminateAccount succeeds');
[$s, $u, $t] = requests();
check($s['path'] === '/v1/operator/accounts/whmcs%3A42/suspend' && $s['body'] === ['reason' => 'Overdue on invoice 1234'], 'SuspendAccount sends the reason');
check($u['path'] === '/v1/operator/accounts/whmcs%3A42/unsuspend' && $u['method'] === 'POST', 'UnsuspendAccount');
check($t['path'] === '/v1/operator/accounts/whmcs%3A42/terminate' && $t['method'] === 'POST', 'TerminateAccount');

// ChangePackage: the new product's plan; a refusal comes back as a readable message.
$team = array_merge($params, ['configoption1' => 'team']);
check(hamnivo_ChangePackage($team) === 'success', 'ChangePackage succeeds');
[$change] = requests();
check($change['method'] === 'PUT' && $change['body'] === ['planKey' => 'team', 'startTrial' => false], 'ChangePackage sends the plan');
$gold = array_merge($params, ['configoption1' => 'gold']);
$refused = hamnivo_ChangePackage($gold);
check($refused === 'Hamnivo: Some fields need attention. (planKey: There is no active plan gold.)', "a refusal reads well: $refused");
requests();
check(
    hamnivo_ChangePackage(array_merge($params, ['configoption1' => ''])) === 'Set the Hamnivo plan key in the product’s module settings.',
    'ChangePackage needs a plan key'
);
check(requests() === [], 'nothing is sent without a plan key');

// A wrong key is refused by Hamnivo; a missing one is caught before any request.
$wrong = array_merge($params, ['serverpassword' => 'hvop_0123456789ab_WrongWrongWrongWrongWrongWrongWrongWrong123']);
check(strpos(hamnivo_SuspendAccount($wrong), 'Hamnivo: Sign in required.') === 0, 'a wrong key is refused');
requests();
$missing = array_merge($params, ['serverpassword' => '', 'serveraccesshash' => '']);
check(strpos(hamnivo_CreateAccount($missing), 'Put a Hamnivo operator API key') === 0, 'a missing key is explained');
check(requests() === [], 'nothing is sent without a key');
$hash = array_merge($params, ['serverpassword' => '', 'serveraccesshash' => KEY]);
check(hamnivo_TestConnection($hash)['success'] === true, 'the access hash field works too');
requests();

// The admin and client areas show the workspace; resend repeats CreateAccount.
$fields = hamnivo_AdminServicesTabFields($params);
check($fields['Hamnivo state'] === 'active' && strpos($fields['Hamnivo workspace'], 'tnt_') !== false, 'admin tab shows the workspace');
$client = hamnivo_ClientArea($params);
check(strpos($client, 'https://studio.example/tenants') !== false, 'client area links to Studio');
check(hamnivo_ResendInvitation($params) === 'success', 'ResendInvitation succeeds');
$last = requests();
check(end($last)['path'] === '/v1/operator/accounts' && end($last)['method'] === 'POST', 'ResendInvitation repeats CreateAccount');

// Module logs mask the key in use (none is known when it was missing).
check(count($logged) > 0 && !in_array(false, array_map(function ($entry) {
    return $entry['replace'] === []
        || (count($entry['replace']) === 1 && strpos($entry['replace'][0], 'hvop_') === 0);
}, $logged), true), 'module log entries mask the key');
check(in_array([KEY], array_column($logged, 'replace'), true), 'the key is masked in the log');

// Unreachable Hamnivo: a readable message.
$down = array_merge($params, ['serverhostname' => '127.0.0.1:1']);
check(strpos(hamnivo_CreateAccount($down), 'Hamnivo could not be reached') === 0, 'an unreachable server is explained');

$meta = hamnivo_MetaData();
check($meta['RequiresServer'] === true && count(hamnivo_ConfigOptions()) === 4, 'metadata and product settings');

echo ($failures === 0 ? 'ok' : 'FAILED') . " - $checks checks, $failures failed\n";
exit($failures === 0 ? 0 : 1);
