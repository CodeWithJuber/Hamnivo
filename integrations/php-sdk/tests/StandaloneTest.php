<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * The WordPress plugin and the WHMCS addon bundle this SDK and load src/autoload.php, because their
 * users do not run Composer. A fresh PHP process with only that file must sign and verify.
 */
#[Group('process')]
final class StandaloneTest extends TestCase
{
    public function testSignsAndVerifiesWithOnlyTheBundledAutoloader(): void
    {
        $script = __DIR__ . '/standalone-check.php';
        $process = proc_open(
            [PHP_BINARY, '-d', 'display_errors=1', '-d', 'error_reporting=-1', $script],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]);
        $errors = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        self::assertSame(0, proc_close($process), $errors . $output);
        self::assertSame('', $errors);
        self::assertSame("assertion ok\nwebhook ok\nno composer\n", $output);
    }

    public function testTheAutoloaderCanBeLoadedTwiceWithoutRedeclaringAnything(): void
    {
        $code = 'require ' . var_export(__DIR__ . '/../src/autoload.php', true) . ';'
            . 'require ' . var_export(__DIR__ . '/../src/autoload.php', true) . ';'
            . 'echo function_exists("Hamnivo\\\\createIdentityAssertion") ? "yes" : "no";';
        $process = proc_open([PHP_BINARY, '-d', 'display_errors=1', '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        self::assertSame(0, proc_close($process));
        self::assertSame('yes', $output);
    }

    public function testEdDsaSaysClearlyThatSodiumIsMissing(): void
    {
        $functions = 'sodium_crypto_sign_seed_keypair,sodium_crypto_sign_secretkey,sodium_crypto_sign_detached';
        $process = proc_open(
            [PHP_BINARY, '-d', 'disable_functions=' . $functions, __DIR__ . '/no-sodium-check.php'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);

        self::assertStringContainsString('EdDSA needs the PHP sodium extension', $output);
    }
}
