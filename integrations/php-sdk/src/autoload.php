<?php

/**
 * Loads the SDK without Composer: `require __DIR__ . '/hamnivo-php/src/autoload.php';`. It is what
 * the WordPress plugin and the WHMCS addon do, since their users do not run Composer.
 */

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $prefix = 'Hamnivo\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

require_once __DIR__ . '/functions.php';
