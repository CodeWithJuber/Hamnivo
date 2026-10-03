<?php

/**
 * Run by StandaloneTest with the sodium functions disabled: EdDSA must say why it cannot sign.
 */

declare(strict_types=1);

require __DIR__ . '/../src/autoload.php';

use Hamnivo\HamnivoIdentityError;

use function Hamnivo\createIdentityAssertion;

$fixtures = json_decode((string) file_get_contents(__DIR__ . '/fixtures/identity.json'), true, 512, JSON_THROW_ON_ERROR);
$key = $fixtures['keys']['EdDSA'];

try {
    createIdentityAssertion([
        'widgetId' => $fixtures['widgetId'],
        'key' => ['kid' => $key['kid'], 'alg' => 'EdDSA', 'privateKey' => $key['privateJwk']],
        'customer' => ['id' => '1'],
    ]);
    echo 'signed';
} catch (HamnivoIdentityError $error) {
    echo $error->getMessage();
}
