<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use ArrayIterator;
use DateTimeImmutable;
use Hamnivo\HamnivoWebhookError;
use Hamnivo\MemoryReplayStore;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

use function Hamnivo\signWebhook;
use function Hamnivo\verifyWebhook;

/** verifyWebhook() with the ways PHP gets headers, replay stores and clocks. */
final class WebhookTest extends TestCase
{
    private const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    private const OTHER = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';
    private const ID = 'evt_01k6a3p0a1b2c3d4e5f6g7h8j9';
    private const NOW = 1_789_459_200;

    private string $body;

    protected function setUp(): void
    {
        $this->body = (string) json_encode([
            'id' => self::ID,
            'type' => 'conversation.created',
            'timestamp' => '2026-09-15T07:59:58.000Z',
            'schemaVersion' => '1.0',
            'tenantId' => 'tnt_01k6a3p0a1b2c3d4e5f6g7h8j9',
            'data' => ['conversationId' => 'conv_01k6a3p0a1b2c3d4e5f6g7h8j9'],
        ]);
    }

    public function testReturnsTheEventAsAnArray(): void
    {
        $event = verifyWebhook($this->body, $this->headers(), ['secret' => self::SECRET, 'now' => self::NOW]);

        self::assertSame(self::ID, $event['id']);
        self::assertSame('conversation.created', $event['type']);
        self::assertSame('conv_01k6a3p0a1b2c3d4e5f6g7h8j9', $event['data']['conversationId']);
    }

    public function testReadsTheHeadersFromEveryShapePhpGivesThem(): void
    {
        $signature = $this->signature();
        $shapes = [
            'getallheaders()' => ['Webhook-Id' => self::ID, 'Webhook-Timestamp' => (string) self::NOW, 'Webhook-Signature' => $signature],
            '$_SERVER' => ['HTTP_WEBHOOK_ID' => self::ID, 'HTTP_WEBHOOK_TIMESTAMP' => (string) self::NOW, 'HTTP_WEBHOOK_SIGNATURE' => $signature, 'REQUEST_METHOD' => 'POST'],
            'WordPress get_headers()' => ['webhook_id' => [self::ID], 'webhook_timestamp' => [(string) self::NOW], 'webhook_signature' => [$signature]],
            'PSR-7 getHeaders()' => ['Webhook-Id' => [self::ID], 'Webhook-Timestamp' => [(string) self::NOW], 'Webhook-Signature' => [$signature]],
            'an iterator' => new ArrayIterator(['webhook-id' => self::ID, 'webhook-timestamp' => (string) self::NOW, 'webhook-signature' => $signature]),
        ];
        foreach ($shapes as $name => $headers) {
            $event = verifyWebhook($this->body, $headers, ['secret' => self::SECRET, 'now' => self::NOW]);
            self::assertSame(self::ID, $event['id'], $name);
        }
    }

    public function testTakesTheTimeFromAClosureOrADateTime(): void
    {
        $options = ['secret' => self::SECRET];
        self::assertSame(self::ID, verifyWebhook($this->body, $this->headers(), $options + ['now' => fn (): int => self::NOW])['id']);
        self::assertSame(self::ID, verifyWebhook($this->body, $this->headers(), $options + ['now' => new DateTimeImmutable('@' . self::NOW)])['id']);
        self::assertSame(
            self::ID,
            verifyWebhook($this->body, $this->headers(), $options + ['now' => fn (): DateTimeImmutable => new DateTimeImmutable('@' . (self::NOW + 299))])['id'],
        );
    }

    public function testUsesTheRealClockByDefault(): void
    {
        $timestamp = time();
        $signature = signWebhook(self::SECRET, self::ID, $timestamp, $this->body);

        self::assertSame(self::ID, verifyWebhook($this->body, $this->headers($signature, $timestamp), ['secret' => self::SECRET])['id']);
        $this->assertRefused('timestamp_out_of_range', $this->headers($signature, $timestamp), ['secret' => self::SECRET, 'now' => $timestamp + 301]);
    }

    public function testRefusesAReplayAndProcessesItAgainAfterARelease(): void
    {
        $clock = self::NOW * 1000;
        $store = new MemoryReplayStore(100, static function () use (&$clock): int {
            return $clock;
        });
        $options = ['secret' => self::SECRET, 'now' => self::NOW, 'replayStore' => $store];

        self::assertSame(self::ID, verifyWebhook($this->body, $this->headers(), $options)['id']);
        $this->assertRefused('duplicate', $this->headers(), $options);
        $store->release(self::ID);
        self::assertSame(self::ID, verifyWebhook($this->body, $this->headers(), $options)['id']);
    }

    public function testDoesNotRememberARefusedRequest(): void
    {
        $store = new MemoryReplayStore();
        $options = ['secret' => self::OTHER, 'now' => self::NOW, 'replayStore' => $store];

        $this->assertRefused('invalid_signature', $this->headers(), $options);
        self::assertTrue($store->claim(self::ID, 600), 'a request that failed must not use up its id');
    }

    public function testTheMemoryStoreForgetsAnIdWhenItsTimeIsUp(): void
    {
        $clock = 1_000_000;
        $store = new MemoryReplayStore(100, static function () use (&$clock): int {
            return $clock;
        });

        self::assertTrue($store->claim('evt_1', 600));
        self::assertFalse($store->claim('evt_1', 600));
        $clock += 599_000;
        self::assertFalse($store->claim('evt_1', 600));
        $clock += 2_000;
        self::assertTrue($store->claim('evt_1', 600));
    }

    public function testTheMemoryStoreKeepsAtMostTheNewestEntriesAndHandlesNumericIds(): void
    {
        $store = new MemoryReplayStore(3, static fn (): int => 5_000);
        foreach (['100', '200', '300', '400'] as $id) {
            self::assertTrue($store->claim($id, 600));
        }

        self::assertTrue($store->claim('100', 600), 'the oldest entry was dropped');
        self::assertFalse($store->claim('400', 600));
    }

    public function testAcceptsEitherSecretDuringARotation(): void
    {
        $headers = $this->headers(signWebhook(self::OTHER, self::ID, self::NOW, $this->body));

        self::assertSame(self::ID, verifyWebhook($this->body, $headers, ['secret' => [self::SECRET, self::OTHER], 'now' => self::NOW])['id']);
        self::assertSame(self::ID, verifyWebhook($this->body, $headers, ['secret' => [self::OTHER], 'now' => self::NOW])['id']);
    }

    public function testRefusesAMissingOrBrokenSecretAsAConfigurationError(): void
    {
        foreach ([null, '', [], 'whsec_', 'whsec_!!!', 42] as $secret) {
            try {
                verifyWebhook($this->body, $this->headers(), ['secret' => $secret, 'now' => self::NOW]);
                self::fail('A bad secret must be refused.');
            } catch (InvalidArgumentException $error) {
                // A setup mistake, not a bad request: it is not a HamnivoWebhookError.
                self::assertNotSame('', $error->getMessage());
            }
        }
    }

    public function testRefusesABadToleranceAndABadReplayStore(): void
    {
        foreach ([-1, '300', 1.5] as $tolerance) {
            try {
                verifyWebhook($this->body, $this->headers(), ['secret' => self::SECRET, 'now' => self::NOW, 'toleranceSeconds' => $tolerance]);
                self::fail('A bad tolerance must be refused.');
            } catch (InvalidArgumentException $error) {
                self::assertStringContainsString('toleranceSeconds', $error->getMessage());
            }
        }
        $this->expectException(InvalidArgumentException::class);
        verifyWebhook($this->body, $this->headers(), ['secret' => self::SECRET, 'now' => self::NOW, 'replayStore' => new \stdClass()]);
    }

    public function testChecksTheSignatureOnTheBytesItWasGiven(): void
    {
        // A server that decodes and re-encodes the JSON changes the bytes, and the signature fails.
        $reencoded = (string) json_encode(json_decode($this->body, true), JSON_PRETTY_PRINT);

        $this->assertRefused('invalid_signature', $this->headers(), ['secret' => self::SECRET, 'now' => self::NOW], $reencoded);
    }

    public function testErrorsCarryTheSameCodesAsTheNodeSdk(): void
    {
        self::assertSame('missing_header', HamnivoWebhookError::MISSING_HEADER);
        self::assertSame('invalid_timestamp', HamnivoWebhookError::INVALID_TIMESTAMP);
        self::assertSame('timestamp_out_of_range', HamnivoWebhookError::TIMESTAMP_OUT_OF_RANGE);
        self::assertSame('invalid_signature', HamnivoWebhookError::INVALID_SIGNATURE);
        self::assertSame('duplicate', HamnivoWebhookError::DUPLICATE);
        self::assertSame('invalid_payload', HamnivoWebhookError::INVALID_PAYLOAD);
    }

    /** @return array<string, string> */
    private function headers(?string $signature = null, int $timestamp = self::NOW): array
    {
        return [
            'webhook-id' => self::ID,
            'webhook-timestamp' => (string) $timestamp,
            'webhook-signature' => $signature ?? $this->signature(),
        ];
    }

    private function signature(): string
    {
        return signWebhook(self::SECRET, self::ID, self::NOW, $this->body);
    }

    /**
     * @param array<array-key, mixed> $headers
     * @param array<string, mixed> $options
     */
    private function assertRefused(string $code, array $headers, array $options, ?string $body = null): void
    {
        try {
            verifyWebhook($body ?? $this->body, $headers, $options);
        } catch (HamnivoWebhookError $error) {
            self::assertSame($code, $error->getErrorCode());

            return;
        }
        self::fail("Expected the request to be refused as {$code}.");
    }
}
