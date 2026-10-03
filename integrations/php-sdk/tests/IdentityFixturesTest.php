<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use Hamnivo\HamnivoIdentityError;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

use function Hamnivo\createIdentityAssertion;

/**
 * The PHP SDK against what @hamnivo/server makes for the same input (tests/fixtures/generate.ts).
 * With the clock and the jti held still, HS256, EdDSA and RS256 give the same text byte for byte.
 * ES256 signatures are random, so those give the same header and payload and a signature that
 * verifies, whichever SDK made it.
 */
final class IdentityFixturesTest extends TestCase
{
    /** @return array<string, array{array<string, mixed>}> */
    public static function deterministicCases(): array
    {
        return self::cases(true);
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function es256Cases(): array
    {
        return self::cases(false);
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function refusals(): array
    {
        $cases = [];
        foreach (Fixtures::identity()['errors'] as $case) {
            $cases[$case['name']] = [$case];
        }

        return $cases;
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('deterministicCases')]
    public function testGivesTheSameTextAsTheNodeSdk(array $case): void
    {
        $this->skipWithoutSodium($case['alg']);
        self::assertSame($case['expected'], Fixtures::sign($case));
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('es256Cases')]
    public function testEs256GivesTheSameHeaderAndPayloadAsTheNodeSdk(array $case): void
    {
        $ours = Fixtures::sign($case);

        $this->assertSameHeaderAndPayload($case['expected'], $ours);
        // Both signatures verify with the public key, checked by another library.
        $key = Fixtures::identity()['keys']['ES256'];
        $claims = Fixtures::verify($ours, 'ES256', $key, $case['now'] + 1);
        self::assertSame($case['options']['customer']['id'], $claims->sub);
        Fixtures::verify($case['expected'], 'ES256', $key, $case['now'] + 1);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('deterministicCases')]
    public function testEveryAssertionVerifiesWithAnotherLibrary(array $case): void
    {
        $this->skipWithoutSodium($case['alg']);
        $key = Fixtures::identity()['keys'][$case['alg']];
        $claims = Fixtures::verify(Fixtures::sign($case), $case['alg'], $key, $case['now'] + 1);

        self::assertSame(Fixtures::identity()['widgetId'], $claims->aud);
        self::assertSame($case['now'] - 5, $claims->iat);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('refusals')]
    public function testRefusesWhatTheNodeSdkRefuses(array $case): void
    {
        try {
            createIdentityAssertion($case['options']);
        } catch (HamnivoIdentityError $error) {
            if ($case['sameMessage']) {
                self::assertSame($case['message'], $error->getMessage());
            }
            self::assertNotSame('', $error->getMessage());

            return;
        }
        self::fail('The Node SDK refuses this input (' . $case['message'] . '), and the PHP SDK signed it.');
    }

    public function testTheFixturesCoverEveryAlgorithmAndEveryRefusal(): void
    {
        $identity = Fixtures::identity();
        $algs = array_unique(array_column($identity['cases'], 'alg'));
        sort($algs);

        self::assertSame(['ES256', 'EdDSA', 'HS256', 'RS256'], $algs);
        self::assertGreaterThanOrEqual(30, count($identity['cases']));
        self::assertGreaterThanOrEqual(40, count($identity['errors']));
    }

    public function testTheClockAndTheJtiAreNotPartOfThePublicApi(): void
    {
        $case = Fixtures::identity()['cases'][0];
        $first = createIdentityAssertion($case['options']);
        $second = createIdentityAssertion($case['options']);

        self::assertNotSame($first, $second);
        self::assertNotSame($case['expected'], $first);
    }

    private function skipWithoutSodium(string $alg): void
    {
        if ($alg === 'EdDSA' && !Fixtures::hasSodium()) {
            self::markTestSkipped('This PHP has no sodium, which EdDSA needs.');
        }
    }

    private function assertSameHeaderAndPayload(string $expected, string $actual): void
    {
        $expectedParts = explode('.', $expected);
        $actualParts = explode('.', $actual);
        self::assertSame($expectedParts[0], $actualParts[0], 'header');
        self::assertSame($expectedParts[1], $actualParts[1], 'payload');
    }

    /** @return array<string, array{array<string, mixed>}> */
    private static function cases(bool $deterministic): array
    {
        $cases = [];
        foreach (Fixtures::identity()['cases'] as $case) {
            if ($case['deterministic'] === $deterministic) {
                $cases[$case['name']] = [$case];
            }
        }

        return $cases;
    }
}
