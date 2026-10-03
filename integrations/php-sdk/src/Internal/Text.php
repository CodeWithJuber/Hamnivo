<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

/**
 * Text checks that give the answers JavaScript gives, so the PHP SDK accepts and refuses the same
 * names and ids as @hamnivo/server. JavaScript counts a string in UTF-16 code units and trims
 * Unicode white space; PHP counts bytes and trims ASCII only.
 *
 * @internal
 */
final class Text
{
    /** What JavaScript's `\s` and `String.prototype.trim` treat as white space. */
    private const SPACE = '[\t\n\x{0B}\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

    public static function isUtf8(string $text): bool
    {
        return preg_match('//u', $text) === 1;
    }

    /** JavaScript's `string.length`: UTF-16 code units, so a character outside the BMP counts 2. */
    public static function length(string $text): int
    {
        $codePoints = preg_match_all('/./su', $text);
        $outsideBmp = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $text);

        return (int) $codePoints + (int) $outsideBmp;
    }

    /** JavaScript's `string.trim() === ''`. */
    public static function isBlank(string $text): bool
    {
        return preg_match('/^' . self::SPACE . '*$/Du', $text) === 1;
    }

    /** JavaScript's `/\s/.test(string)`. */
    public static function hasSpace(string $text): bool
    {
        return preg_match('/' . self::SPACE . '/u', $text) === 1;
    }
}
