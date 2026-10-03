<?php
/**
 * Loads the addon's classes. The PHP SDK that signs identities is loaded later, only when this PHP
 * can run it (see Identity::sdkAvailable()), so the chat works on every PHP that WHMCS runs on.
 */

declare(strict_types=1);

foreach (['Settings', 'Store', 'CapsuleStore', 'Services', 'CurrentClient', 'Identity', 'Output', 'Endpoint', 'ConnectionTest', 'Admin'] as $hamnivoWhmcsClass) {
    require_once __DIR__ . '/' . $hamnivoWhmcsClass . '.php';
}
unset($hamnivoWhmcsClass);
