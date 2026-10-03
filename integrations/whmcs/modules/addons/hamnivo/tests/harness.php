<?php
/**
 * A very small test harness. It prints TAP (the lines "ok 1 - name" and "not ok 2 - name"), and
 * exits with 1 when a test failed. Plain PHP 7.4, so the same suite runs on every PHP the addon
 * supports, on this machine's PHP and in WordPress Playground.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

class Failure extends Exception
{
}

class Skipped extends Exception
{
}

$GLOBALS['harness'] = ['count' => 0, 'failed' => 0, 'skipped' => 0];

echo '# PHP ' . PHP_VERSION . "\n";

/** Runs one test. A thrown exception, a failed assertion or a PHP warning fails it. */
function test(string $name, callable $body): void
{
    $GLOBALS['harness']['count']++;
    $number = $GLOBALS['harness']['count'];
    set_error_handler(static function ($level, $message, $file, $line) {
        if (!(error_reporting() & $level)) {
            return false;
        }
        throw new ErrorException($message, 0, $level, $file, $line);
    });
    try {
        $body();
        echo "ok {$number} - {$name}\n";
    } catch (Skipped $skip) {
        $GLOBALS['harness']['skipped']++;
        echo "ok {$number} - {$name} # SKIP " . $skip->getMessage() . "\n";
    } catch (Throwable $error) {
        $GLOBALS['harness']['failed']++;
        echo "not ok {$number} - {$name}\n";
        foreach (explode("\n", get_class($error) . ': ' . $error->getMessage()) as $line) {
            echo "# {$line}\n";
        }
        if (!$error instanceof Failure) {
            echo '# at ' . $error->getFile() . ':' . $error->getLine() . "\n";
        }
    } finally {
        restore_error_handler();
    }
}

function skip(string $why): void
{
    throw new Skipped($why);
}

function finish(): void
{
    $h = $GLOBALS['harness'];
    echo "1..{$h['count']}\n";
    echo "# {$h['count']} tests, {$h['failed']} failed, {$h['skipped']} skipped\n";
    exit($h['failed'] > 0 ? 1 : 0);
}

/** @param mixed $expected @param mixed $actual */
function same($expected, $actual, string $what = ''): void
{
    if ($expected !== $actual) {
        throw new Failure(($what !== '' ? $what . ': ' : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

/** @param mixed $condition */
function truthy($condition, string $what): void
{
    if (!$condition) {
        throw new Failure('expected: ' . $what);
    }
}

function contains(string $needle, string $haystack, string $what = ''): void
{
    if (strpos($haystack, $needle) === false) {
        throw new Failure(($what !== '' ? $what . ': ' : '') . 'expected to find ' . var_export($needle, true) . ' in ' . var_export(strlen($haystack) > 700 ? substr($haystack, 0, 700) . '…' : $haystack, true));
    }
}

function lacks(string $needle, string $haystack, string $what = ''): void
{
    if (strpos($haystack, $needle) !== false) {
        throw new Failure(($what !== '' ? $what . ': ' : '') . 'expected not to find ' . var_export($needle, true) . ' in ' . var_export(strlen($haystack) > 700 ? substr($haystack, 0, 700) . '…' : $haystack, true));
    }
}

/** Runs code and returns what it printed. */
function capture(callable $body): string
{
    ob_start();
    try {
        $body();
    } finally {
        $output = (string) ob_get_clean();
    }

    return $output;
}

/** The decoded parts of an assertion. */
function jwt(string $assertion): array
{
    $parts = explode('.', $assertion);
    truthy(count($parts) === 3, 'an assertion with three parts');

    return [
        'header' => json_decode(b64u($parts[0]), true),
        'payload' => json_decode(b64u($parts[1]), true),
        'input' => $parts[0] . '.' . $parts[1],
        'raw' => b64u($parts[2]),
    ];
}

function b64u(string $text): string
{
    return (string) base64_decode(strtr($text, '-_', '+/') . str_repeat('=', (4 - strlen($text) % 4) % 4), true);
}
