<?php

/**
 * Signs assertions and webhooks with the PHP SDK, the real clock and fresh random values, and prints
 * them as JSON. tests/cross-check.ts runs this and checks every result with @hamnivo/server's side:
 * jose with the gateway's options for assertions, and verifyWebhook for webhooks.
 *
 * It loads only src/autoload.php, as a vendored copy in a WordPress plugin does, so it also shows
 * that the SDK works without Composer.
 */

declare(strict_types=1);

require __DIR__ . '/../../src/autoload.php';

use function Hamnivo\createIdentityAssertion;
use function Hamnivo\signWebhook;

$identity = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/identity.json'), true, 512, JSON_THROW_ON_ERROR);
$webhooks = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/webhooks.json'), true, 512, JSON_THROW_ON_ERROR);

$customers = [
    ['id' => 'customer-42', 'name' => 'Ayesha Khan', 'email' => 'ayesha@example.com', 'emailVerified' => true],
    ['id' => 'u-1', 'name' => 'عائشة خان', 'email' => 'ayesha@example.pk', 'emailVerified' => true],
    ['id' => 'e-1', 'name' => 'Sam 🙂 Lee'],
    ['id' => '7'],
    ['id' => 'j-1', 'name' => "say \"hi\" \\ a/b \u{0001} \n \u{2028} \u{7f} é", 'email' => 'omar@example.com', 'emailVerified' => false],
];

$out = ['widgetId' => $identity['widgetId'], 'assertions' => [], 'webhooks' => []];
foreach (['HS256', 'ES256', 'EdDSA', 'RS256'] as $alg) {
    $key = $identity['keys'][$alg];
    $keyOption = $alg === 'HS256'
        ? ['kid' => $key['kid'], 'alg' => $alg, 'secret' => $key['secret']]
        : ['kid' => $key['kid'], 'alg' => $alg, 'privateKey' => $key['privateJwk']];
    // ES256 signatures are random, and about one in 128 has a leading zero in r or s: sign many.
    $rounds = $alg === 'ES256' ? 400 : 4;
    for ($round = 0; $round < $rounds; $round++) {
        foreach ($customers as $customer) {
            $out['assertions'][] = [
                'alg' => $alg,
                'customer' => $customer,
                'assertion' => createIdentityAssertion([
                    'widgetId' => $identity['widgetId'],
                    'key' => $keyOption,
                    'customer' => $customer,
                ]),
            ];
        }
    }
}

foreach ($webhooks['signatures'] as $case) {
    $timestamp = time();
    $id = 'evt_' . bin2hex(random_bytes(8));
    $out['webhooks'][] = [
        'secret' => $case['secret'],
        'id' => $id,
        'timestamp' => $timestamp,
        'body' => $case['body'],
        'signature' => signWebhook($case['secret'], $id, $timestamp, $case['body']),
    ];
}

echo json_encode($out, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
