<?php
/**
 * A stand-in for the Hamnivo operator API, for the module's tests (php -S … this file). It
 * records every request in the file named by HAMNIVO_MOCK_LOG and answers like the gateway.
 */

const KEY = 'hvop_0123456789ab_TestKeyTestKeyTestKeyTestKeyTestKeyTest123';

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = file_get_contents('php://input');
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

file_put_contents(
    (string) getenv('HAMNIVO_MOCK_LOG'),
    json_encode(['method' => $method, 'path' => $path, 'auth' => $auth, 'body' => $body ? json_decode($body, true) : null]) . "\n",
    FILE_APPEND
);

function answer(int $status, array $json): void
{
    http_response_code($status);
    header('Content-Type: ' . ($status >= 400 ? 'application/problem+json' : 'application/json'));
    echo json_encode($json);
}

function account(string $status, string $plan = 'pro'): array
{
    return [
        'tenantId' => 'tnt_01j9zk7w3xq8r4t2v6m5n1p0cd',
        'externalRef' => 'whmcs:42',
        'name' => 'Acme Ltd',
        'slug' => 'acme-ltd',
        'status' => $status,
        'plan' => ['key' => $plan, 'name' => ucfirst($plan)],
        'trialEndsAt' => null,
        'studioUrl' => 'https://studio.example/tenants',
        'meters' => [],
    ];
}

if ($auth !== 'Bearer ' . KEY) {
    answer(401, ['type' => 'about:blank', 'code' => 'AUTH_REQUIRED', 'status' => 401, 'title' => 'Sign in required', 'detail' => 'The operator API key is not valid.']);
    return true;
}

$account = '/v1/operator/accounts/whmcs%3A42';
switch ("$method $path") {
    case 'GET /v1/operator/ping':
        answer(200, ['ok' => true, 'plans' => ['free', 'pro']]);
        break;
    case 'POST /v1/operator/accounts':
        answer(201, account('active'));
        break;
    case "GET $account":
        answer(200, account('active'));
        break;
    case "POST $account/suspend":
        answer(200, account('suspended'));
        break;
    case "POST $account/unsuspend":
        answer(200, account('active'));
        break;
    case "POST $account/terminate":
        answer(200, account('closing'));
        break;
    case "PUT $account/plan":
        $plan = json_decode($body, true)['planKey'] ?? '';
        if ($plan !== 'pro' && $plan !== 'team') {
            answer(422, [
                'type' => 'about:blank',
                'code' => 'VALIDATION_FAILED',
                'status' => 422,
                'title' => 'Some fields need attention',
                'fields' => [['path' => 'planKey', 'message' => "There is no active plan $plan."]],
            ]);
            break;
        }
        answer(200, account('active', $plan));
        break;
    default:
        answer(404, ['type' => 'about:blank', 'code' => 'NOT_FOUND', 'status' => 404, 'title' => 'Not found', 'detail' => 'No such workspace.']);
}
return true;
