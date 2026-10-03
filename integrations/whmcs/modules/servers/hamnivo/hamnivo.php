<?php
/**
 * Hamnivo provisioning module for WHMCS.
 *
 * Sells Hamnivo workspaces as a WHMCS product: an order creates a workspace on your Hamnivo
 * server and emails its owner an invitation; suspension, unsuspension, termination and package
 * changes follow automatically. It calls the Hamnivo operator API with an operator API key
 * (created in Hamnivo's platform console, under Sign-up and billing).
 *
 * Server settings (Setup > Products/Services > Servers):
 *   Hostname  your Hamnivo API host, e.g. api.example.com (or a full https:// address)
 *   Password  the operator API key (hvop_…); the Access Hash field works too
 *   Secure    on (HTTPS)
 *
 * Every call is safe to repeat: the workspace is found by the external reference
 * "whmcs:<service id>", so a retried CreateAccount returns the same workspace.
 *
 * Self-contained: PHP 7.4 or later with cURL and JSON, no other dependencies.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

if (!class_exists('HamnivoOperatorApi')) {
    /** A small client for the Hamnivo operator API. */
    final class HamnivoOperatorApi
    {
        /** @var string */
        private $baseUrl;
        /** @var string */
        private $key;

        public function __construct(string $baseUrl, string $key)
        {
            $this->baseUrl = rtrim($baseUrl, '/');
            $this->key = $key;
        }

        /** Builds the client from the server settings WHMCS passes to every module function. */
        public static function fromParams(array $params): self
        {
            $host = trim((string) ($params['serverhostname'] ?? ''));
            if ($host === '') {
                $host = trim((string) ($params['serverip'] ?? ''));
            }
            if ($host === '') {
                throw new RuntimeException('Set the Hamnivo API host as the server hostname.');
            }
            if (!preg_match('#^https?://#i', $host)) {
                $secure = !empty($params['serversecure']) && $params['serversecure'] !== 'off';
                $port = (string) ($params['serverport'] ?? '');
                $host = ($secure ? 'https://' : 'http://') . $host
                    . ($port !== '' && $port !== '0' && $port !== ($secure ? '443' : '80') ? ':' . $port : '');
            }
            $key = trim((string) ($params['serverpassword'] ?? ''));
            if ($key === '') {
                $key = trim((string) ($params['serveraccesshash'] ?? ''));
            }
            if (strpos($key, 'hvop_') !== 0) {
                throw new RuntimeException(
                    'Put a Hamnivo operator API key (hvop_…) in the server password field.'
                );
            }
            return new self($host, $key);
        }

        /** The key, so module logs can mask it. */
        public function secret(): string
        {
            return $this->key;
        }

        /**
         * Sends one request and returns the decoded answer. Throws HamnivoApiError with a short,
         * readable message when Hamnivo refuses or cannot be reached.
         *
         * @param array<string, mixed>|null $body
         * @return array<string, mixed>
         */
        public function request(string $method, string $path, ?array $body = null): array
        {
            $curl = curl_init($this->baseUrl . $path);
            $headers = [
                'Authorization: Bearer ' . $this->key,
                'Accept: application/json',
                'User-Agent: Hamnivo-WHMCS/1.0',
            ];
            $options = [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT => 30,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ];
            if ($body !== null) {
                $headers[] = 'Content-Type: application/json';
                $options[CURLOPT_POSTFIELDS] = json_encode(
                    $body,
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
                );
            }
            $options[CURLOPT_HTTPHEADER] = $headers;
            curl_setopt_array($curl, $options);
            $raw = curl_exec($curl);
            $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            $error = curl_error($curl);
            curl_close($curl);
            if ($raw === false) {
                throw new HamnivoApiError('Hamnivo could not be reached: ' . $error, 0, '');
            }
            $decoded = json_decode((string) $raw, true);
            if ($status < 200 || $status >= 300) {
                throw new HamnivoApiError(self::problem(is_array($decoded) ? $decoded : [], $status), $status, (string) $raw);
            }
            return is_array($decoded) ? $decoded : [];
        }

        /** A readable line from an RFC 9457 problem answer. */
        private static function problem(array $problem, int $status): string
        {
            $title = isset($problem['title']) ? (string) $problem['title'] : 'HTTP ' . $status;
            $detail = isset($problem['detail']) ? ' ' . (string) $problem['detail'] : '';
            $fields = '';
            if (!empty($problem['fields']) && is_array($problem['fields'])) {
                $parts = [];
                foreach ($problem['fields'] as $field) {
                    if (is_array($field) && isset($field['path'], $field['message'])) {
                        $parts[] = $field['path'] . ': ' . $field['message'];
                    }
                }
                $fields = $parts ? ' (' . implode('; ', $parts) . ')' : '';
            }
            return 'Hamnivo: ' . $title . '.' . $detail . $fields;
        }
    }

    final class HamnivoApiError extends RuntimeException
    {
        /** @var string */
        public $response;

        public function __construct(string $message, int $status, string $response)
        {
            parent::__construct($message, $status);
            $this->response = $response;
        }
    }
}

/** The workspace of a WHMCS service, as the operator API names it. */
function hamnivo_reference(array $params): string
{
    return 'whmcs:' . (int) $params['serviceid'];
}

/** Writes the call to the WHMCS module log (Utilities > Logs > Module Log), key masked. */
function hamnivo_log(string $action, $request, $response, ?HamnivoOperatorApi $api = null): void
{
    if (function_exists('logModuleCall')) {
        logModuleCall('hamnivo', $action, $request, $response, '', $api ? [$api->secret()] : []);
    }
}

/**
 * Runs one operator API call for a module function and turns the outcome into what WHMCS
 * expects: 'success', or a message saying what went wrong.
 *
 * @param array<string, mixed>|null $body
 */
function hamnivo_call(array $params, string $action, string $method, string $path, ?array $body = null): string
{
    $api = null;
    try {
        $api = HamnivoOperatorApi::fromParams($params);
        $answer = $api->request($method, $path, $body);
        hamnivo_log($action, ['method' => $method, 'path' => $path, 'body' => $body], $answer, $api);
        return 'success';
    } catch (HamnivoApiError $error) {
        hamnivo_log($action, ['method' => $method, 'path' => $path, 'body' => $body], $error->response, $api);
        return $error->getMessage();
    } catch (Throwable $error) {
        hamnivo_log($action, ['method' => $method, 'path' => $path], $error->getMessage(), $api);
        return $error->getMessage();
    }
}

function hamnivo_MetaData(): array
{
    return [
        'DisplayName' => 'Hamnivo',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'DefaultNonSSLPort' => '80',
        'DefaultSSLPort' => '443',
        'ServiceSingleSignOnLabel' => false,
        'AdminSingleSignOnLabel' => false,
    ];
}

/** Product settings (configoption1 to configoption4). */
function hamnivo_ConfigOptions(): array
{
    return [
        'Plan key' => [
            'Type' => 'text',
            'Size' => '25',
            'Default' => '',
            'Description' => 'The Hamnivo plan this product sells, for example pro. Empty: the server’s default plan.',
        ],
        'Start trial' => [
            'Type' => 'yesno',
            'Description' => 'Start with the plan’s trial days (the workspace falls back to the free plan when it ends).',
        ],
        'Language' => [
            'Type' => 'dropdown',
            'Options' => 'en,ar,hi,ur',
            'Default' => 'en',
            'Description' => 'The workspace’s default language.',
        ],
        'Create first brand' => [
            'Type' => 'yesno',
            'Description' => 'Create a first brand (named after the client, with the service domain as its website) and set up its chat.',
        ],
    ];
}

/** At most 120 characters, as the operator API accepts. */
function hamnivo_clip(string $value): string
{
    return function_exists('mb_substr') ? mb_substr($value, 0, 120) : substr($value, 0, 120);
}

/** The workspace name: the client's company, else their name, else the service domain. */
function hamnivo_workspace_name(array $params): string
{
    $client = isset($params['clientsdetails']) && is_array($params['clientsdetails']) ? $params['clientsdetails'] : [];
    $person = trim(($client['firstname'] ?? '') . ' ' . ($client['lastname'] ?? ''));
    foreach ([$client['companyname'] ?? '', $person, $params['domain'] ?? '', 'Workspace ' . (int) $params['serviceid']] as $candidate) {
        $candidate = trim((string) $candidate);
        if ($candidate !== '') {
            return hamnivo_clip($candidate);
        }
    }
    return 'Workspace';
}

/** The CreateAccount request body, from the order. */
function hamnivo_account_body(array $params): array
{
    $client = isset($params['clientsdetails']) && is_array($params['clientsdetails']) ? $params['clientsdetails'] : [];
    $email = trim((string) ($client['email'] ?? ''));
    $person = trim(($client['firstname'] ?? '') . ' ' . ($client['lastname'] ?? ''));
    $name = hamnivo_workspace_name($params);
    $language = in_array($params['configoption3'] ?? '', ['en', 'ar', 'hi', 'ur'], true) ? $params['configoption3'] : 'en';
    $body = [
        'externalRef' => hamnivo_reference($params),
        'name' => $name,
        'defaultLocale' => $language,
        'owner' => ['email' => $email, 'name' => hamnivo_clip($person !== '' ? $person : $email)],
        'startTrial' => ($params['configoption2'] ?? '') === 'on',
    ];
    $plan = trim((string) ($params['configoption1'] ?? ''));
    if ($plan !== '') {
        $body['planKey'] = $plan;
    }
    if (($params['configoption4'] ?? '') === 'on') {
        $brand = ['name' => $name];
        $domain = trim((string) ($params['domain'] ?? ''));
        if ($domain !== '') {
            $website = preg_match('#^https?://#i', $domain) ? $domain : 'https://' . $domain;
            if (filter_var($website, FILTER_VALIDATE_URL)) {
                $brand['website'] = $website;
            }
        }
        $body['brand'] = $brand;
    }
    return $body;
}

/** Checks the host and key from the server settings page (Test Connection). */
function hamnivo_TestConnection(array $params): array
{
    $api = null;
    try {
        $api = HamnivoOperatorApi::fromParams($params);
        $answer = $api->request('GET', '/v1/operator/ping');
        hamnivo_log('TestConnection', '/v1/operator/ping', $answer, $api);
        return ['success' => !empty($answer['ok']), 'error' => empty($answer['ok']) ? 'Unexpected answer from Hamnivo.' : ''];
    } catch (Throwable $error) {
        hamnivo_log('TestConnection', '/v1/operator/ping', $error->getMessage(), $api);
        return ['success' => false, 'error' => $error->getMessage()];
    }
}

/** A new order: creates the workspace and invites the client as its owner. */
function hamnivo_CreateAccount(array $params): string
{
    return hamnivo_call($params, 'CreateAccount', 'POST', '/v1/operator/accounts', hamnivo_account_body($params));
}

function hamnivo_SuspendAccount(array $params): string
{
    $reason = trim((string) ($params['suspendreason'] ?? ''));
    return hamnivo_call(
        $params,
        'SuspendAccount',
        'POST',
        '/v1/operator/accounts/' . rawurlencode(hamnivo_reference($params)) . '/suspend',
        ['reason' => $reason !== '' ? substr($reason, 0, 500) : 'Suspended in WHMCS']
    );
}

function hamnivo_UnsuspendAccount(array $params): string
{
    return hamnivo_call(
        $params,
        'UnsuspendAccount',
        'POST',
        '/v1/operator/accounts/' . rawurlencode(hamnivo_reference($params)) . '/unsuspend',
        ['reason' => 'Unsuspended in WHMCS']
    );
}

/** Closes the workspace for good; its data stays until the platform operator deletes it. */
function hamnivo_TerminateAccount(array $params): string
{
    return hamnivo_call(
        $params,
        'TerminateAccount',
        'POST',
        '/v1/operator/accounts/' . rawurlencode(hamnivo_reference($params)) . '/terminate',
        ['reason' => 'Terminated in WHMCS']
    );
}

/** An upgrade or downgrade: the workspace moves to the new product's plan. */
function hamnivo_ChangePackage(array $params): string
{
    $plan = trim((string) ($params['configoption1'] ?? ''));
    if ($plan === '') {
        return 'Set the Hamnivo plan key in the product’s module settings.';
    }
    return hamnivo_call(
        $params,
        'ChangePackage',
        'PUT',
        '/v1/operator/accounts/' . rawurlencode(hamnivo_reference($params)) . '/plan',
        ['planKey' => $plan, 'startTrial' => false]
    );
}

function hamnivo_AdminCustomButtonArray(): array
{
    return ['Resend owner invitation' => 'ResendInvitation'];
}

/** Sends the owner invitation again (only while nobody has accepted it). */
function hamnivo_ResendInvitation(array $params): string
{
    return hamnivo_call($params, 'ResendInvitation', 'POST', '/v1/operator/accounts', hamnivo_account_body($params));
}

/** The workspace as Hamnivo reports it, or null when it cannot be read right now. */
function hamnivo_account(array $params): ?array
{
    try {
        $api = HamnivoOperatorApi::fromParams($params);
        return $api->request('GET', '/v1/operator/accounts/' . rawurlencode(hamnivo_reference($params)));
    } catch (Throwable $error) {
        return null;
    }
}

function hamnivo_escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** The workspace's state and plan on the service page in the WHMCS admin area. */
function hamnivo_AdminServicesTabFields(array $params): array
{
    $account = hamnivo_account($params);
    if ($account === null) {
        return ['Hamnivo workspace' => 'Not found, or Hamnivo cannot be reached right now.'];
    }
    $plan = isset($account['plan']['name']) ? (string) $account['plan']['name'] : 'No plan';
    if (!empty($account['trialEndsAt'])) {
        $plan .= ' (trial until ' . substr((string) $account['trialEndsAt'], 0, 10) . ')';
    }
    return [
        'Hamnivo workspace' => hamnivo_escape((string) ($account['name'] ?? '')) . ' · '
            . hamnivo_escape((string) ($account['tenantId'] ?? '')),
        'Hamnivo state' => hamnivo_escape((string) ($account['status'] ?? '')),
        'Hamnivo plan' => hamnivo_escape($plan),
    ];
}

/** The client area: where to sign in, and the plan. */
function hamnivo_ClientArea(array $params): string
{
    $account = hamnivo_account($params);
    if ($account === null) {
        return '<p>Your Hamnivo workspace is being prepared. Check your email for the invitation.</p>';
    }
    $studio = (string) ($account['studioUrl'] ?? '');
    $plan = isset($account['plan']['name']) ? (string) $account['plan']['name'] : '';
    $html = '<p><strong>' . hamnivo_escape((string) ($account['name'] ?? '')) . '</strong>';
    if ($plan !== '') {
        $html .= ' · ' . hamnivo_escape($plan);
    }
    $html .= '</p>';
    if (($account['status'] ?? '') === 'suspended') {
        $html .= '<p>This workspace is suspended. Pay any open invoice to reactivate it.</p>';
    }
    if ($studio !== '' && preg_match('#^https?://#i', $studio)) {
        $html .= '<p><a class="btn btn-primary" href="' . hamnivo_escape($studio)
            . '" target="_blank" rel="noopener">Open Hamnivo Studio</a></p>';
    }
    return $html;
}
