<?php

declare(strict_types=1);

namespace Hamnivo\Tests;

use Hamnivo\Internal\Base64Url;
use Hamnivo\Internal\Der;
use Hamnivo\Internal\Text;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The helpers that make PHP answer as JavaScript does. */
final class TextTest extends TestCase
{
    /** @return array<string, array{string, int}> */
    public static function lengths(): array
    {
        return [
            'empty' => ['', 0],
            'ASCII' => ['abc', 3],
            'Urdu' => ['عائشة', 5],
            'Hindi, whose letters are marks and consonants' => ['आयशा', 4],
            'an accented letter written as one character' => ["\u{00E9}", 1],
            'an accented letter written with a mark' => ["e\u{0301}", 2],
            'an emoji, two UTF-16 units' => ['🙂', 2],
            'a flag, two emoji' => ['🇵🇰', 4],
            'a line break' => ["a\nb", 3],
        ];
    }

    #[DataProvider('lengths')]
    public function testCountsInUtf16UnitsLikeJavaScript(string $text, int $units): void
    {
        self::assertSame($units, Text::length($text));
    }

    /** @return array<string, array{string, bool, bool}> Text, whether it is blank, whether it has white space. */
    public static function whiteSpace(): array
    {
        return [
            'empty' => ['', true, false],
            'spaces' => ['   ', true, true],
            'tabs and breaks' => ["\t\n\r", true, true],
            'a no-break space' => ["\u{00A0}", true, true],
            'an ideographic space' => ["\u{3000}", true, true],
            'a byte order mark' => ["\u{FEFF}", true, true],
            'a line separator' => ["\u{2028}\u{2029}", true, true],
            'a letter between spaces' => [' a ', false, true],
            'zero' => ['0', false, false],
            'a zero-width space is not white space' => ["\u{200B}", false, false],
            'a Mongolian vowel separator is not white space' => ["\u{180E}", false, false],
        ];
    }

    #[DataProvider('whiteSpace')]
    public function testTrimsAndSpotsWhatJavaScriptDoes(string $text, bool $blank, bool $hasSpace): void
    {
        self::assertSame($blank, Text::isBlank($text));
        self::assertSame($hasSpace, Text::hasSpace($text));
    }

    public function testRecognisesInvalidUtf8(): void
    {
        self::assertTrue(Text::isUtf8('عائشة 🙂'));
        self::assertFalse(Text::isUtf8("\xC3\x28"));
        self::assertFalse(Text::isUtf8("\xED\xA0\x80"), 'a lone surrogate');
    }

    public function testBase64UrlRoundTripsAndRefusesWhatIsNotBase64Url(): void
    {
        $bytes = random_bytes(33);
        self::assertSame($bytes, Base64Url::decode(Base64Url::encode($bytes)));
        self::assertSame('', Base64Url::encode(''));
        self::assertNull(Base64Url::decode('ab+/'));
        self::assertNull(Base64Url::decode('abcde'));
        self::assertNull(Base64Url::decode('ab=='));
        self::assertSame('a', Base64Url::decode('YQ'));
    }

    public function testConvertsEcdsaDerSignaturesToTheJwsForm(): void
    {
        $short = "\x30\x08\x02\x02\x00\x80\x02\x02\x01\x02";
        self::assertSame(str_pad("\x80", 32, "\x00", STR_PAD_LEFT) . str_pad("\x01\x02", 32, "\x00", STR_PAD_LEFT), Der::ecdsaToJose($short, 32));

        $long = "\x30\x81\x46\x02\x21\x00" . str_repeat("\xFF", 32) . "\x02\x21\x00" . str_repeat("\xAA", 32);
        self::assertSame(str_repeat("\xFF", 32) . str_repeat("\xAA", 32), Der::ecdsaToJose($long, 32));

        foreach (['', 'abc', "\x30\x00", "\x31\x08\x02\x02\x00\x80\x02\x02\x01\x02", "\x30\x07\x02\x02\x00\x80\x02\x02\x01\x02", "\x30\x08\x02\x02\x00\x80\x02\x02\x01"] as $broken) {
            self::assertNull(Der::ecdsaToJose($broken, 32));
        }
    }
}
