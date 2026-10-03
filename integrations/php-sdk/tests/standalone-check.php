<?php

/**
 * Run by StandaloneTest in a fresh process: only the bundled autoloader, no Composer.
 */

declare(strict_types=1);

require __DIR__ . '/../src/autoload.php';

use function Hamnivo\createIdentityAssertion;
use function Hamnivo\signWebhook;
use function Hamnivo\verifyWebhook;

$assertion = createIdentityAssertion([
    'widgetId' => 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
    'key' => ['kid' => 'hk_standalone', 'alg' => 'HS256', 'secret' => 'abc_DEF-123'],
    'customer' => ['id' => 42, 'name' => 'Ayesha Khan'],
]);
echo count(explode('.', $assertion)) === 3 ? "assertion ok\n" : "assertion broken\n";

$body = '{"id":"evt_1","type":"x"}';
$timestamp = time();
$event = verifyWebhook(
    $body,
    ['webhook-id' => 'evt_1', 'webhook-timestamp' => (string) $timestamp, 'webhook-signature' => signWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'evt_1', $timestamp, $body)],
    ['secret' => 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
);
echo $event['id'] === 'evt_1' ? "webhook ok\n" : "webhook broken\n";

// Composer's autoloader was never loaded in this process.
echo class_exists('Composer\\Autoload\\ClassLoader', false) ? "composer loaded\n" : "no composer\n";
