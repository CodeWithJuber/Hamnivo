<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use Hamnivo\HamnivoWebhookError;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

use function Hamnivo\signWebhook;
use function Hamnivo\verifyWebhook;

/**
 * The PHP SDK against what @hamnivo/server signs and decides for the same requests
 * (tests/fixtures/generate.ts): the same signatures, the same events, the same refusals.
 */
final class WebhookFixturesTest extends TestCase
{
    /** @return array<string, array{array<string, mixed>}> */
    public static function signatures(): array
    {
        $cases = [];
        foreach (Fixtures::webhooks()['signatures'] as $case) {
            $cases[$case['name']] = [$case];
        }

        return $cases;
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function scenarios(): array
    {
        $cases = [];
        foreach (Fixtures::webhooks()['scenarios'] as $case) {
            $cases[$case['name']] = [$case];
        }

        return $cases;
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('signatures')]
    public function testSignsAsTheNodeSdkDoes(array $case): void
    {
        self::assertSame(
            $case['signature'],
            signWebhook($case['secret'], $case['id'], $case['timestamp'], $case['body']),
        );
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('scenarios')]
    public function testDecidesAsTheNodeSdkDoes(array $case): void
    {
        $options = ['secret' => $case['options']['secret'], 'now' => $case['options']['now']];
        if (isset($case['options']['toleranceSeconds'])) {
            $options['toleranceSeconds'] = $case['options']['toleranceSeconds'];
        }

        if (isset($case['expect']['error'])) {
            try {
                verifyWebhook($case['body'], $case['headers'], $options);
            } catch (HamnivoWebhookError $error) {
                self::assertSame($case['expect']['error'], $error->getErrorCode());

                return;
            }
            self::fail('The Node SDK refuses this request (' . $case['expect']['error'] . '), and the PHP SDK accepted it.');
        }

        self::assertSame($case['expect']['event'], verifyWebhook($case['body'], $case['headers'], $options));
    }

    public function testTheFixturesCoverEveryRefusal(): void
    {
        $errors = [];
        foreach (Fixtures::webhooks()['scenarios'] as $case) {
            if (isset($case['expect']['error'])) {
                $errors[$case['expect']['error']] = true;
            }
        }
        $codes = array_keys($errors);
        sort($codes);

        self::assertSame(
            ['invalid_payload', 'invalid_signature', 'invalid_timestamp', 'missing_header', 'timestamp_out_of_range'],
            $codes,
        );
    }
}
