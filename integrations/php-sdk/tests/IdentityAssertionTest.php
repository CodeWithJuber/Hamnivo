<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use Hamnivo\HamnivoIdentityError;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

use function Hamnivo\createIdentityAssertion;

/**
 * createIdentityAssertion() with keys made by PHP and the real clock: every algorithm, every way
 * to pass a key, and the properties that must hold for every assertion.
 */
final class IdentityAssertionTest extends TestCase
{
    private const WIDGET = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
    private const SECRET = 'q3Zp0xv9L2m8Yk1T5bN7cR4dWf6HjA0sEuG-iO_hXzo';

    /** @var array<string, array<string, mixed>> */
    private static array $keys = [];

    /** A key PHP makes for the test, or a skipped test where this PHP cannot make one. */
    private static function keyFor(string $alg): array
    {
        if (!isset(self::$keys[$alg])) {
            try {
                self::$keys[$alg] = Fixtures::newKey($alg);
            } catch (\RuntimeException $error) {
                self::markTestSkipped($error->getMessage());
            }
        }

        return self::$keys[$alg];
    }

    /** @return array<string, array{string}> */
    public static function algorithms(): array
    {
        return ['HS256' => ['HS256'], 'ES256' => ['ES256'], 'EdDSA' => ['EdDSA'], 'RS256' => ['RS256']];
    }

    #[DataProvider('algorithms')]
    public function testSignsAssertionsThatAnotherLibraryVerifies(string $alg): void
    {
        $assertion = createIdentityAssertion($this->options($alg));
        $claims = Fixtures::verify($assertion, $alg, $this->fixtureKey($alg), time());

        self::assertSame('customer-42', $claims->sub);
        self::assertSame(self::WIDGET, $claims->aud);
        self::assertSame('Ayesha Khan', $claims->name);
        self::assertSame('ayesha@example.com', $claims->email);
        self::assertTrue($claims->email_verified);
        self::assertSame(120, $claims->exp - $claims->iat);
        self::assertSame(['alg' => $alg, 'kid' => 'shop-2026', 'typ' => 'JWT'], $this->header($assertion));
    }

    public function testSignsEs256WhoseSignatureIsAlwaysTheRightLength(): void
    {
        // r or s often starts with a zero byte or a high bit, and DER writes those differently:
        // a thousand signatures show that the conversion to JWS handles both.
        $key = $this->fixtureKey('ES256');
        for ($i = 0; $i < 1000; $i++) {
            $assertion = createIdentityAssertion($this->options('ES256'));
            $signature = base64_decode(strtr(explode('.', $assertion)[2], '-_', '+/'), true);
            self::assertSame(64, strlen((string) $signature));
            Fixtures::verify($assertion, 'ES256', $key, time());
        }
    }

    public function testAcceptsThePrivateKeyAsJwkTextAndPemAndOpenSslKey(): void
    {
        foreach (['ES256', 'RS256'] as $alg) {
            $key = self::keyFor($alg);
            $forms = [
                'JWK text' => json_encode($key['privateJwk'], JSON_THROW_ON_ERROR),
                'PEM' => $key['pem'],
                'OpenSSL key' => $key['key'],
            ];
            foreach ($forms as $form => $privateKey) {
                $options = $this->options($alg);
                $options['key']['privateKey'] = $privateKey;
                $assertion = createIdentityAssertion($options);
                Fixtures::verify($assertion, $alg, $this->fixtureKey($alg), time());
                self::assertNotSame('', $assertion, "{$alg} as {$form}");
            }
        }
    }

    public function testSignsWithAJwkThatHasOnlyThePrivateValueForEs256(): void
    {
        $options = $this->options('ES256');
        $options['key']['privateKey'] = ['kty' => 'EC', 'crv' => 'P-256', 'd' => self::keyFor('ES256')['privateJwk']['d']];

        Fixtures::verify(createIdentityAssertion($options), 'ES256', $this->fixtureKey('ES256'), time());
        $this->addToAssertionCount(1);
    }

    public function testDatesIatFiveSecondsBackAndGivesEveryAssertionAFreshJti(): void
    {
        $before = time();
        $jtis = [];
        for ($i = 0; $i < 200; $i++) {
            $claims = $this->claims(createIdentityAssertion($this->options('HS256')));
            self::assertGreaterThanOrEqual($before - 5, $claims['iat']);
            self::assertLessThanOrEqual(time() - 5, $claims['iat']);
            self::assertSame($claims['iat'] + 120, $claims['exp']);
            self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{22}$/D', $claims['jti']);
            self::assertSame(16, strlen(Fixtures::decode($claims['jti'])));
            $jtis[$claims['jti']] = true;
        }
        self::assertCount(200, $jtis);
    }

    public function testSignsOnlyTheClaimsThatAreSet(): void
    {
        $bare = $this->options('HS256');
        $bare['customer'] = ['id' => 'customer-7', 'name' => null, 'email' => null, 'emailVerified' => null];
        self::assertSame(['sub', 'aud', 'iat', 'exp', 'jti'], array_keys($this->claims(createIdentityAssertion($bare))));
        self::assertSame(
            ['sub', 'aud', 'iat', 'exp', 'jti', 'name', 'email', 'email_verified'],
            array_keys($this->claims(createIdentityAssertion($this->options('HS256')))),
        );
    }

    public function testKeepsAnUnverifiedEmailMarkedUnverified(): void
    {
        $options = $this->options('HS256');
        $options['customer'] = ['id' => 'customer-8', 'email' => 'omar@example.com', 'emailVerified' => false];
        $claims = $this->claims(createIdentityAssertion($options));

        self::assertSame('omar@example.com', $claims['email']);
        self::assertFalse($claims['email_verified']);
    }

    public function testCapsTheLifetimeAtFiveMinutes(): void
    {
        foreach ([[10, 10], [60, 60], [300, 300], [301, 300], [86_400, 300]] as [$asked, $given]) {
            $options = $this->options('HS256');
            $options['ttlSeconds'] = $asked;
            $claims = $this->claims(createIdentityAssertion($options));
            self::assertSame($given, $claims['exp'] - $claims['iat']);
        }
    }

    public function testAcceptsAWholeNumberAsTheCustomerId(): void
    {
        // WordPress and WHMCS ids are integers. The Node SDK asks for String(id), which is this.
        $options = $this->options('HS256');
        $options['customer']['id'] = 42;

        self::assertSame('42', $this->claims(createIdentityAssertion($options))['sub']);
    }

    public function testRefusesAFloatOrABooleanAsTheCustomerId(): void
    {
        foreach ([4.5, true, [], null] as $id) {
            $options = $this->options('HS256');
            $options['customer']['id'] = $id;
            $this->assertRefused($options, 'customer.id');
        }
    }

    public function testRefusesInvalidUtf8InTheNameAndTheId(): void
    {
        foreach (['id', 'name'] as $field) {
            $options = $this->options('HS256');
            $options['customer'][$field] = "bad \xC3\x28 text";
            $this->assertRefused($options, 'valid UTF-8');
        }
    }

    public function testRefusesAPemKeyForEdDsa(): void
    {
        $options = $this->options('EdDSA');
        $options['key']['privateKey'] = self::keyFor('ES256')['pem'];

        $this->assertRefused($options, 'EdDSA needs key.privateKey as a JWK');
    }

    public function testRefusesAPublicOpenSslKeyAndAWrongKindOfOpenSslKey(): void
    {
        $public = openssl_pkey_get_public((string) openssl_pkey_get_details(self::keyFor('ES256')['key'])['key']);
        $options = $this->options('ES256');
        $options['key']['privateKey'] = $public;
        $this->assertRefused($options, 'is a public key');

        $options['key']['privateKey'] = self::keyFor('RS256')['key'];
        $this->assertRefused($options, 'ES256 needs an EC P-256 private key');
    }

    public function testRefusesTextThatIsNeitherAJwkNorAPemKey(): void
    {
        $options = $this->options('ES256');
        foreach (['not a key', '{"kty":', '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----'] as $text) {
            $options['key']['privateKey'] = $text;
            $this->assertRefused($options, 'key.privateKey');
        }
    }

    public function testNeverRepeatsTheSecretOrThePrivateKeyInAMessage(): void
    {
        $secret = 'super-secret value with spaces';
        $options = $this->options('HS256');
        $options['key']['secret'] = $secret;
        $messages = [$this->refusal($options)];

        $options = $this->options('ES256');
        $options['key']['secret'] = self::SECRET;
        $messages[] = $this->refusal($options);

        $options = $this->options('RS256');
        $options['key']['privateKey'] = array_merge(self::keyFor('RS256')['privateJwk'], ['alg' => 'ES256']);
        $messages[] = $this->refusal($options);

        foreach ($messages as $message) {
            self::assertStringNotContainsString('super-secret', $message);
            self::assertStringNotContainsString(self::SECRET, $message);
            self::assertStringNotContainsString(self::keyFor('RS256')['privateJwk']['d'], $message);
        }
    }

    public function testTheAssertionNeverContainsTheKey(): void
    {
        foreach (['ES256', 'EdDSA', 'RS256'] as $alg) {
            $assertion = createIdentityAssertion($this->options($alg));
            self::assertStringNotContainsString(self::keyFor($alg)['privateJwk']['d'], $assertion);
        }
        self::assertStringNotContainsString(self::SECRET, createIdentityAssertion($this->options('HS256')));
    }

    public function testUsesTheCharactersOfTheHs256SecretAsTheKey(): void
    {
        // Hamnivo's secret looks like base64url, but the gateway does not decode it.
        $assertion = createIdentityAssertion($this->options('HS256'));
        [$header, $payload, $signature] = explode('.', $assertion);
        $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$header}.{$payload}", self::SECRET, true)), '+/', '-_'), '=');
        $decoded = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$header}.{$payload}", (string) Fixtures::decode(self::SECRET), true)), '+/', '-_'), '=');

        self::assertSame($expected, $signature);
        self::assertNotSame($decoded, $signature);
    }

    /** @return array<string, mixed> */
    private function options(string $alg): array
    {
        $key = $alg === 'HS256'
            ? ['kid' => 'shop-2026', 'alg' => 'HS256', 'secret' => self::SECRET]
            : ['kid' => 'shop-2026', 'alg' => $alg, 'privateKey' => self::keyFor($alg)['privateJwk']];

        return [
            'widgetId' => self::WIDGET,
            'key' => $key,
            'customer' => ['id' => 'customer-42', 'name' => 'Ayesha Khan', 'email' => 'ayesha@example.com', 'emailVerified' => true],
        ];
    }

    /** @return array<string, mixed> The key as the verifying side holds it. */
    private function fixtureKey(string $alg): array
    {
        return $alg === 'HS256'
            ? ['kid' => 'shop-2026', 'secret' => self::SECRET]
            : ['kid' => 'shop-2026', 'publicJwk' => self::keyFor($alg)['publicJwk']];
    }

    /** @return array<string, mixed> */
    private function header(string $assertion): array
    {
        return json_decode(Fixtures::decode(explode('.', $assertion)[0]), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    private function claims(string $assertion): array
    {
        return json_decode(Fixtures::decode(explode('.', $assertion)[1]), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @param array<string, mixed> $options */
    private function assertRefused(array $options, string $mention): void
    {
        self::assertStringContainsString($mention, $this->refusal($options));
    }

    /** @param array<string, mixed> $options */
    private function refusal(array $options): string
    {
        try {
            createIdentityAssertion($options);
        } catch (HamnivoIdentityError $error) {
            return $error->getMessage();
        }
        self::fail('Expected a HamnivoIdentityError.');
    }
}
