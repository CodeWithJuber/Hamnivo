<?php
/**
 * The addon's page in the WHMCS admin area: Addons, Hamnivo Chat.
 */

declare(strict_types=1);

namespace Hamnivo\Whmcs;

/**
 * Shows what is set, what is wrong, and the result of Test connection. WHMCS draws the settings
 * form itself (Configuration, System Settings, Addon Modules), so this page is for checking.
 * Everything printed is escaped, and the saved key is never printed.
 */
final class Admin
{
    public const HELP_URL = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guide/integrations/whmcs.md';
    public const IDENTITY_URL = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guides/identity.md';

    /**
     * @param string                                                       $link   The page's own address, from modulelink.
     * @param string                                                       $token  The CSRF field WHMCS makes for forms: generate_token('form').
     * @param array{ok:bool,checks:list<array{ok:bool,label:string,detail:string}>}|null $result The answer of Test connection, once it ran.
     */
    public static function render(Settings $settings, string $systemUrl, string $link, string $token, ?array $result): string
    {
        $e = [Output::class, 'attribute'];
        $html = '<div class="hamnivo-chat">';
        $html .= '<h2>Hamnivo Chat</h2>';

        if ($settings->isConfigured()) {
            $html .= '<p class="successbox"><strong>The chat is on.</strong> It appears on every page of the client area.</p>';
        } else {
            $html .= '<p class="infobox"><strong>The chat is off.</strong> Enter the widget ID and the chat address to turn it on.</p>';
        }
        foreach ($settings->problems() as $problem) {
            $html .= '<p class="errorbox">' . $e($problem) . '</p>';
        }

        $html .= '<p>Open <strong>Configuration, System Settings, Addon Modules</strong>, and click <strong>Configure</strong> next to Hamnivo Chat to change these settings. '
            . 'You find the values in Hamnivo Studio, under Settings, Brands and install: choose your brand, and under "Install the chat" click "Copy install code". '
            . '<a href="' . $e(self::HELP_URL) . '" target="_blank" rel="noopener noreferrer">How to find these</a></p>';

        $html .= '<table class="datatable" style="width:100%;max-width:60em">'
            . '<tr><th>Setting</th><th>Value</th></tr>'
            . self::row('Widget ID', $settings->widgetId() ?: 'not set')
            . self::row('Chat address', $settings->chatUrl() ?: 'not set')
            . self::row('API address', $settings->apiUrl() ?: 'not set (the chat uses its own default)')
            . self::row('Verified clients', self::identityState($settings))
            . self::row('Key ID', $settings->keyId() ?: 'not set')
            . self::row('Key', $settings->hasSecret() ? 'saved (never shown again)' : 'not set')
            . self::row('Email addresses', $settings->trustEmails() ? 'shared: WHMCS makes clients confirm their email' : 'not shared: the chat gets the name only')
            . self::row('Product names', $settings->shareProducts() ? 'shared: the names of the client\'s active products' : 'not shared')
            . '</table>';

        $reason = Identity::unavailableReason();
        if ($settings->identityWanted() && $reason !== null) {
            $html .= '<p class="errorbox">' . $e($reason) . '</p>';
        }
        if (!$settings->identityWanted()) {
            $html .= '<p>To let signed-in clients see their own conversations on any device, register an identity key in Hamnivo, then tick <strong>Verify signed-in clients</strong>. '
                . '<a href="' . $e(self::IDENTITY_URL) . '" target="_blank" rel="noopener noreferrer">How to register an identity key</a></p>';
        }

        $html .= '<form method="post" action="' . $e($link) . '" style="margin:1.5em 0">'
            . $token
            . '<input type="submit" name="hamnivo_test" value="Test connection" class="btn btn-default" />'
            . ' <span class="text-muted">The test asks the chat address and the API the way a visitor\'s browser does. It only reads. Nothing is created in Hamnivo.</span>'
            . '</form>';

        if ($result !== null) {
            $html .= '<p><strong>' . ($result['ok'] ? 'Everything works.' : 'Something needs a look. See below.') . '</strong></p><ul>';
            foreach ($result['checks'] as $check) {
                $html .= '<li class="' . ($check['ok'] ? 'text-success' : 'text-danger') . '"><strong>'
                    . ($check['ok'] ? 'Works' : 'Problem') . ': ' . $e($check['label']) . '.</strong> ' . $e($check['detail']) . '</li>';
            }
            $html .= '</ul>';
        }

        $html .= '<p>This WHMCS is at <code>' . $e(ConnectionTest::origin($systemUrl)) . '</code>. Add this address to the brand\'s allowed websites in Hamnivo Studio. The chat opens only on those websites.</p>';

        return $html . '</div>';
    }

    private static function identityState(Settings $settings): string
    {
        if (!$settings->identityWanted()) {
            return 'off';
        }

        return Identity::isReady($settings) ? 'on' : 'on, but not working yet (see below)';
    }

    private static function row(string $name, string $value): string
    {
        return '<tr><td>' . Output::attribute($name) . '</td><td>' . Output::attribute($value) . '</td></tr>';
    }
}
