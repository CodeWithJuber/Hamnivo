<?php
/**
 * The addon's settings, as the WHMCS admin saved them under Addons, Hamnivo Chat.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Reads and cleans the settings. WHMCS does not check what an admin types into an addon's fields,
 * so nothing is trusted here: an address that does not fit reads as empty, and the admin page says
 * what to fix.
 */
final class Settings
{
    /** The name of the addon module, as WHMCS knows it. */
    public const MODULE = 'hamnivo';

    private const FIELDS = [
        'widget_id',
        'chat_url',
        'api_url',
        'identity_enabled',
        'identity_kid',
        'identity_secret',
        'trust_emails',
        'share_products',
    ];

    /** @var array<string,string> */
    private $values = [];

    /**
     * @param array<string,mixed> $raw Setting name and value, as WHMCS stores them in tbladdonmodules.
     */
    public function __construct(array $raw)
    {
        foreach (self::FIELDS as $field) {
            $value = $raw[$field] ?? '';
            $this->values[$field] = is_scalar($value) ? trim((string) $value) : '';
        }
    }

    /**
     * The saved settings. A constant HAMNIVO_IDENTITY_SECRET in configuration.php replaces the
     * saved key, so that the key can stay out of the database.
     */
    public static function load(Store $store): self
    {
        $raw = $store->settings();
        if (defined('HAMNIVO_IDENTITY_SECRET') && is_string(HAMNIVO_IDENTITY_SECRET)) {
            $raw['identity_secret'] = HAMNIVO_IDENTITY_SECRET;
        }

        return new self($raw);
    }

    public function widgetId(): string
    {
        return self::isWidgetId($this->values['widget_id']) ? $this->values['widget_id'] : '';
    }

    /** The chat address, reduced to its origin: the loader finds the chat app at the origin of its own address. */
    public function chatUrl(): string
    {
        return (string) self::address($this->values['chat_url'], true);
    }

    public function apiUrl(): string
    {
        return (string) self::address($this->values['api_url'], false);
    }

    public function isConfigured(): bool
    {
        return $this->widgetId() !== '' && $this->chatUrl() !== '';
    }

    /** What is wrong with the address and widget ID settings, in words for the admin. */
    public function problems(): array
    {
        $problems = [];
        if ($this->values['widget_id'] !== '' && $this->widgetId() === '') {
            $problems[] = 'The widget ID is wid_ followed by 26 lowercase letters and digits. Copy it again from Hamnivo Studio.';
        }
        if ($this->values['chat_url'] !== '' && $this->chatUrl() === '') {
            $problems[] = 'The chat address starts with https:// (or http:// for local testing), for example https://chat.example.com.';
        }
        if ($this->values['api_url'] !== '' && $this->apiUrl() === '') {
            $problems[] = 'The API address starts with https:// (or http:// for local testing), for example https://api.example.com.';
        }
        if ($this->values['identity_kid'] !== '' && preg_match('/^[A-Za-z0-9._-]{1,64}$/', $this->values['identity_kid']) !== 1) {
            $problems[] = 'The key ID has 1 to 64 letters, digits, dots, underscores or dashes.';
        }

        return $problems;
    }

    public function identityWanted(): bool
    {
        return self::flag($this->values['identity_enabled']);
    }

    public function keyId(): string
    {
        return $this->values['identity_kid'];
    }

    /** The HS256 secret, or a private key as JSON. */
    public function secret(): string
    {
        return $this->values['identity_secret'];
    }

    public function hasSecret(): bool
    {
        return $this->values['identity_secret'] !== '';
    }

    public function trustEmails(): bool
    {
        return self::flag($this->values['trust_emails']);
    }

    public function shareProducts(): bool
    {
        return self::flag($this->values['share_products']);
    }

    /** WHMCS keeps a ticked yes/no field as "on", and an unticked one as an empty text. */
    private static function flag(string $value): bool
    {
        return in_array(strtolower($value), ['on', '1', 'yes', 'true'], true);
    }

    public static function isWidgetId(string $text): bool
    {
        return preg_match('/^wid_[0-9a-z]{26}$/', $text) === 1;
    }

    /**
     * A web address made ready to use: only http or https, a real host name, no spaces. The chat
     * address keeps only its origin, the API address its path too, without a trailing slash. An
     * address without a scheme is taken as https.
     *
     * @return string|null The address, an empty string for nothing, or null when it does not fit.
     */
    public static function address(string $raw, bool $originOnly): ?string
    {
        $raw = trim($raw);
        if ($raw === '') {
            return '';
        }
        if (preg_match('/\s/', $raw) === 1) {
            return null;
        }
        if (strpos($raw, '://') === false) {
            if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $raw) === 1 && preg_match('#^[^/]+:\d+(/|$)#', $raw) !== 1) {
                return null;
            }
            $raw = 'https://' . $raw;
        }
        $parts = parse_url($raw);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        $host = $parts['host'];
        $isHost = preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i', $host) === 1
            || preg_match('/^\[[0-9a-f:.]+\]$/i', $host) === 1;
        if (($scheme !== 'https' && $scheme !== 'http') || !$isHost) {
            return null;
        }
        $origin = $scheme . '://' . strtolower($host) . (isset($parts['port']) ? ':' . $parts['port'] : '');

        return $originOnly ? $origin : rtrim($origin . ($parts['path'] ?? ''), '/');
    }
}
