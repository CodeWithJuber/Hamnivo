<?php
/**
 * What the addon adds to the head of every client area page.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Builds the HTML that the ClientAreaHeadOutput hook returns: the chat loader, and when verified
 * clients are on, the small script that passes the assertion to the chat. Every value is escaped.
 */
final class Output
{
    public const VERSION = '0.1.0';

    /** The address the page asks for an assertion, under the WHMCS address. */
    public static function endpoint(string $systemUrl): string
    {
        return rtrim($systemUrl, '/') . '/index.php?m=' . Settings::MODULE . '&a=identity';
    }

    /**
     * The head HTML: empty until the widget ID and the chat address are set.
     *
     * @param string   $systemUrl The WHMCS address, with its path, from the hook's systemurl.
     * @param int|null $clientId  The signed-in client, or null.
     */
    public static function head(Settings $settings, string $systemUrl, ?int $clientId): string
    {
        if (!$settings->isConfigured()) {
            return '';
        }
        $loader = '<script async src="' . self::attribute($settings->chatUrl() . '/loader.js') . '"'
            . ' data-widget-id="' . self::attribute($settings->widgetId()) . '"';
        if ($settings->apiUrl() !== '') {
            $loader .= ' data-api="' . self::attribute($settings->apiUrl()) . '"';
        }
        $html = $loader . '></script>' . "\n";

        if (Identity::isReady($settings) && $systemUrl !== '') {
            $config = ['loggedIn' => $clientId !== null, 'endpoint' => self::endpoint($systemUrl)];
            $script = rtrim($systemUrl, '/') . '/modules/addons/' . Settings::MODULE . '/assets/identity.js?v=' . self::VERSION;
            $html .= '<script>window.HamnivoWhmcs = ' . self::json($config) . ';</script>' . "\n"
                . '<script src="' . self::attribute($script) . '" defer></script>' . "\n";
        }

        return $html;
    }

    /** Text made safe for an HTML attribute. */
    public static function attribute(string $text): string
    {
        return htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /** JSON that cannot end its script tag or open another. */
    public static function json($value): string
    {
        return (string) json_encode($value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES);
    }
}
