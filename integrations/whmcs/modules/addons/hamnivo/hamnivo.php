<?php
/**
 * Hamnivo Chat for WHMCS: an addon module that puts the chat on every page of the client area, and
 * tells it who is signed in.
 *
 * Install: upload this folder to modules/addons/ of your WHMCS, then activate it under
 * Configuration, System Settings, Addon Modules. The steps are in
 * docs/guide/integrations/whmcs.md of the Hamnivo repository.
 *
 * @see https://developers.whmcs.com/addon-modules/
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/bootstrap.php';

use Hamnivo\Whmcs\Admin;
use Hamnivo\Whmcs\ConnectionTest;
use Hamnivo\Whmcs\CurrentClient;
use Hamnivo\Whmcs\Endpoint;
use Hamnivo\Whmcs\Identity;
use Hamnivo\Whmcs\Output;
use Hamnivo\Whmcs\Services;
use Hamnivo\Whmcs\Settings;

/**
 * The addon's name and its settings. WHMCS draws the form from `fields` and keeps the values in
 * tbladdonmodules.
 */
function hamnivo_config()
{
    return [
        'name' => 'Hamnivo Chat',
        'description' => 'Puts Hamnivo Chat on every page of the client area, and shows signed-in clients their own conversations. Find the widget ID and the addresses in Hamnivo Studio, under Settings, Brands and install.',
        'author' => 'Hamnivo',
        'language' => 'english',
        'version' => Output::VERSION,
        'fields' => [
            'widget_id' => [
                'FriendlyName' => 'Widget ID',
                'Type' => 'text',
                'Size' => '40',
                'Default' => '',
                'Description' => 'The brand\'s widget ID. It starts with wid_ and is not a secret.',
            ],
            'chat_url' => [
                'FriendlyName' => 'Chat address',
                'Type' => 'text',
                'Size' => '40',
                'Default' => '',
                'Description' => 'Where Hamnivo Chat runs, for example https://chat.example.com.',
            ],
            'api_url' => [
                'FriendlyName' => 'API address',
                'Type' => 'text',
                'Size' => '40',
                'Default' => '',
                'Description' => 'The Hamnivo API of the same installation, for example https://api.example.com.',
            ],
            'identity_enabled' => [
                'FriendlyName' => 'Verify signed-in clients',
                'Type' => 'yesno',
                'Description' => 'Tell the chat who is signed in, so a client sees their own conversations on any device. Needs PHP 8.1 and an identity key.',
            ],
            'identity_kid' => [
                'FriendlyName' => 'Key ID',
                'Type' => 'text',
                'Size' => '40',
                'Default' => '',
                'Description' => 'The ID of the identity key you registered in Hamnivo.',
            ],
            'identity_secret' => [
                'FriendlyName' => 'Key',
                'Type' => 'password',
                'Size' => '40',
                'Default' => '',
                'Description' => 'The HS256 secret that Hamnivo showed you once, exactly as shown, or a private key as JSON. To keep it out of the database, define HAMNIVO_IDENTITY_SECRET in configuration.php instead.',
            ],
            'trust_emails' => [
                'FriendlyName' => 'Share email addresses',
                'Type' => 'yesno',
                'Description' => 'Tick only if WHMCS makes clients confirm their email address (General Settings, Security). Hamnivo then keeps the address. Otherwise the chat gets the name only.',
            ],
            'share_products' => [
                'FriendlyName' => 'Share product names',
                'Type' => 'yesno',
                'Description' => 'Tell the chat the names of the signed-in client\'s active products, for example "Business Hosting". Names only, read only: never a domain, a username, a password or a key.',
            ],
        ],
    ];
}

function hamnivo_activate()
{
    return [
        'status' => 'success',
        'description' => 'Hamnivo Chat is active. Click Configure to enter the widget ID and the addresses, then open Addons, Hamnivo Chat to test the connection.',
    ];
}

function hamnivo_deactivate()
{
    // The settings stay in tbladdonmodules, so that turning the addon on again needs no new setup.
    return ['status' => 'success', 'description' => 'Hamnivo Chat is off. Its settings are kept.'];
}

function hamnivo_upgrade($vars)
{
    // Nothing to migrate yet.
}

/**
 * The page under Addons, Hamnivo Chat: what is set, what is wrong, and Test connection.
 */
function hamnivo_output($vars)
{
    $store = Services::store();
    $settings = Settings::load($store);
    $systemUrl = $store->systemUrl();
    $result = null;
    if (isset($_POST['hamnivo_test'])) {
        $result = ConnectionTest::run($settings, $systemUrl, [ConnectionTest::class, 'curl']);
    }
    $token = function_exists('generate_token') ? generate_token('form') : '';

    echo Admin::render($settings, $systemUrl, (string) ($vars['modulelink'] ?? 'addonmodules.php?module=hamnivo'), (string) $token, $result);
}

/**
 * The client area address of the addon. Its one job is index.php?m=hamnivo&a=identity, which gives
 * the page a fresh identity assertion for the signed-in client. It sends JSON and ends the request.
 */
function hamnivo_clientarea($vars)
{
    $action = isset($_GET['a']) && is_string($_GET['a']) ? $_GET['a'] : '';
    $headers = [];
    foreach (['X-Requested-With' => 'HTTP_X_REQUESTED_WITH', 'Sec-Fetch-Site' => 'HTTP_SEC_FETCH_SITE'] as $name => $key) {
        if (isset($_SERVER[$key]) && is_string($_SERVER[$key])) {
            $headers[strtolower($name)] = $_SERVER[$key];
        }
    }

    if ($action !== 'identity') {
        $answer = ['status' => 404, 'headers' => ['Content-Type' => 'text/plain; charset=utf-8'], 'body' => 'Not found'];
    } else {
        $store = Services::store();
        $answer = Endpoint::respond(
            isset($_SERVER['REQUEST_METHOD']) && is_string($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET',
            $headers,
            CurrentClient::id(),
            Settings::load($store),
            $store
        );
    }

    // Nothing WHMCS has already printed may come before the JSON.
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($answer['status']);
    foreach ($answer['headers'] as $name => $value) {
        header($name . ': ' . $value);
    }
    echo $answer['body'];
    exit;
}
