<?php
/**
 * The hooks of Hamnivo Chat for WHMCS. WHMCS loads this file for every active addon module.
 *
 * ClientAreaHeadOutput adds the chat loader to the head of every client area page. A failure here
 * must never break the client area, so it answers with nothing.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/bootstrap.php';

add_hook('ClientAreaHeadOutput', 1, function ($vars) {
    try {
        $store = \Hamnivo\Whmcs\Services::store();
        $settings = \Hamnivo\Whmcs\Settings::load($store);
        $systemUrl = is_array($vars) && isset($vars['systemurl']) && is_string($vars['systemurl'])
            ? $vars['systemurl']
            : $store->systemUrl();

        return \Hamnivo\Whmcs\Output::head($settings, $systemUrl, \Hamnivo\Whmcs\CurrentClient::id());
    } catch (\Throwable $error) {
        return '';
    }
});
