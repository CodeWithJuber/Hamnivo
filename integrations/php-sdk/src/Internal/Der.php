<?php

declare(strict_types=1);

namespace Hamnivo\Internal;

/**
 * The little DER (ASN.1) that PHP's OpenSSL functions need: private keys built from the members of
 * a JSON Web Key, and ECDSA signatures turned from DER into the fixed-length form JWS uses.
 *
 * @internal
 */
final class Der
{
    /** The named curve prime256v1 (P-256), as OBJECT IDENTIFIER 1.2.840.10045.3.1.7. */
    private const OID_PRIME256V1 = "\x06\x08\x2A\x86\x48\xCE\x3D\x03\x01\x07";

    /** An RSAPrivateKey (RFC 8017, PKCS #1) from the unsigned big-endian members of a JWK. */
    public static function rsaPrivateKey(string $n, string $e, string $d, string $p, string $q, string $dp, string $dq, string $qi): string
    {
        return self::sequence(
            self::integer("\x00"),
            self::integer($n),
            self::integer($e),
            self::integer($d),
            self::integer($p),
            self::integer($q),
            self::integer($dp),
            self::integer($dq),
            self::integer($qi),
        );
    }

    /**
     * An ECPrivateKey (RFC 5915, SEC 1) for P-256. The public point is left out when `x` and `y`
     * are not both given; OpenSSL works it out from the private value.
     */
    public static function p256PrivateKey(string $d, ?string $x, ?string $y): string
    {
        $parts = [
            self::integer("\x01"),
            self::tlv(0x04, $d),
            self::tlv(0xA0, self::OID_PRIME256V1),
        ];
        if ($x !== null && $y !== null) {
            $parts[] = self::tlv(0xA1, self::tlv(0x03, "\x00\x04" . $x . $y));
        }

        return self::sequence(...$parts);
    }

    public static function pem(string $label, string $der): string
    {
        return "-----BEGIN {$label}-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END {$label}-----\n";
    }

    /**
     * Turns the DER signature OpenSSL makes for ECDSA (SEQUENCE of two INTEGERs, r and s) into r
     * and s as fixed-length big-endian numbers joined together, which is what JWS wants. Null when
     * the signature is not what an ES256 signature looks like.
     */
    public static function ecdsaToJose(string $der, int $size): ?string
    {
        $length = strlen($der);
        if ($length < 8 || $der[0] !== "\x30") {
            return null;
        }
        $offset = 2;
        $sequenceLength = ord($der[1]);
        if ($sequenceLength === 0x81) {
            $sequenceLength = ord($der[2]);
            $offset = 3;
        }
        if ($sequenceLength !== $length - $offset) {
            return null;
        }
        $numbers = [];
        for ($i = 0; $i < 2; $i++) {
            if (($der[$offset] ?? '') !== "\x02") {
                return null;
            }
            $integerLength = ord($der[$offset + 1] ?? "\x00");
            $integer = substr($der, $offset + 2, $integerLength);
            if (strlen($integer) !== $integerLength) {
                return null;
            }
            $integer = ltrim($integer, "\x00");
            if (strlen($integer) > $size) {
                return null;
            }
            $numbers[] = str_pad($integer, $size, "\x00", STR_PAD_LEFT);
            $offset += 2 + $integerLength;
        }

        return $offset === $length ? $numbers[0] . $numbers[1] : null;
    }

    private static function sequence(string ...$items): string
    {
        return self::tlv(0x30, implode('', $items));
    }

    /** An INTEGER from an unsigned big-endian number. */
    private static function integer(string $unsigned): string
    {
        $unsigned = ltrim($unsigned, "\x00");
        if ($unsigned === '') {
            $unsigned = "\x00";
        }
        if ((ord($unsigned[0]) & 0x80) !== 0) {
            $unsigned = "\x00" . $unsigned;
        }

        return self::tlv(0x02, $unsigned);
    }

    private static function tlv(int $tag, string $content): string
    {
        $length = strlen($content);
        if ($length < 0x80) {
            return chr($tag) . chr($length) . $content;
        }
        $bytes = ltrim(pack('N', $length), "\x00");

        return chr($tag) . chr(0x80 | strlen($bytes)) . $bytes . $content;
    }
}
