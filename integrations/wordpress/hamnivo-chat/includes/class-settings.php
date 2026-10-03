<?php
/**
 * The saved settings, and what is made from them.
 *
 * @package Hamnivo_Chat
 */

namespace Hamnivo\Chat;

defined( 'ABSPATH' ) || exit;

/**
 * Reads, cleans and saves the plugin's settings. One option holds them all, as the first version of
 * this plugin did, so a site that used it keeps its settings.
 */
final class Settings {

	const OPTION = 'hamnivo_chat';
	const GROUP  = 'hamnivo_chat';

	/**
	 * Every setting with its empty value. Only these keys are ever saved.
	 *
	 * @return array<string,string>
	 */
	public static function defaults(): array {
		return array(
			'widget_id'       => '',
			'chat_url'        => '',
			'api_url'         => '',
			'identity'        => '0',
			'identity_kid'    => '',
			'identity_secret' => '',
			'trust_emails'    => '0',
		);
	}

	/**
	 * The saved settings, with every key present.
	 *
	 * @return array<string,string>
	 */
	public static function all(): array {
		$saved    = get_option( self::OPTION, array() );
		$saved    = is_array( $saved ) ? $saved : array();
		$settings = self::defaults();
		foreach ( $settings as $key => $default ) {
			if ( isset( $saved[ $key ] ) && is_scalar( $saved[ $key ] ) ) {
				$settings[ $key ] = (string) $saved[ $key ];
			}
		}
		return $settings;
	}

	/**
	 * One saved setting.
	 *
	 * @param string $key A key of defaults().
	 */
	public static function get( string $key ): string {
		$all = self::all();
		return isset( $all[ $key ] ) ? $all[ $key ] : '';
	}

	/**
	 * The chat is on once the widget ID and the chat address are set.
	 */
	public static function is_configured(): bool {
		return '' !== self::get( 'widget_id' ) && '' !== self::get( 'chat_url' );
	}

	/**
	 * The identity key, which is a secret or a private key. A constant in wp-config.php wins, so the
	 * key can stay out of the database.
	 */
	public static function identity_secret(): string {
		if ( defined( 'HAMNIVO_CHAT_IDENTITY_SECRET' ) && is_string( HAMNIVO_CHAT_IDENTITY_SECRET ) ) {
			return trim( HAMNIVO_CHAT_IDENTITY_SECRET );
		}
		return self::get( 'identity_secret' );
	}

	/**
	 * Whether the identity key comes from wp-config.php.
	 */
	public static function identity_secret_is_constant(): bool {
		return defined( 'HAMNIVO_CHAT_IDENTITY_SECRET' ) && is_string( HAMNIVO_CHAT_IDENTITY_SECRET );
	}

	/**
	 * Cleans what the settings form sent. A value that does not fit keeps the saved one, and the
	 * settings page says why. It is the sanitize callback of the option.
	 *
	 * @param mixed $input The form's values, already unslashed by WordPress.
	 * @return array<string,string>
	 */
	public static function sanitize( $input ): array {
		$input = is_array( $input ) ? $input : array();
		$clean = self::all();

		// Pasting the install code from Hamnivo Studio fills in what is still empty in the form.
		$input = self::fill_from_install_code( $input );

		$widget_id = trim( sanitize_text_field( self::text( $input, 'widget_id' ) ) );
		if ( '' === $widget_id || self::is_widget_id( $widget_id ) ) {
			$clean['widget_id'] = $widget_id;
		} else {
			self::complain( 'widget_id', __( 'The widget ID is wid_ followed by 26 lowercase letters and digits. Copy it again from Hamnivo Studio.', 'hamnivo-chat' ) );
		}

		$chat_url = self::address( self::text( $input, 'chat_url' ), true );
		if ( null === $chat_url ) {
			self::complain( 'chat_url', __( 'The chat address starts with https:// (or http:// for local testing). It is where Hamnivo Chat runs, for example https://chat.example.com.', 'hamnivo-chat' ) );
		} else {
			$clean['chat_url'] = $chat_url;
		}

		$api_url = self::address( self::text( $input, 'api_url' ), false );
		if ( null === $api_url ) {
			self::complain( 'api_url', __( 'The API address starts with https:// (or http:// for local testing), for example https://api.example.com.', 'hamnivo-chat' ) );
		} else {
			$clean['api_url'] = $api_url;
		}

		$clean['identity']     = '1' === self::text( $input, 'identity' ) ? '1' : '0';
		$clean['trust_emails'] = '1' === self::text( $input, 'trust_emails' ) ? '1' : '0';

		$kid = trim( sanitize_text_field( self::text( $input, 'identity_kid' ) ) );
		if ( '' === $kid || preg_match( '/^[A-Za-z0-9._-]{1,64}$/', $kid ) ) {
			$clean['identity_kid'] = $kid;
		} else {
			self::complain( 'identity_kid', __( 'The key ID has 1 to 64 letters, digits, dots, underscores or dashes. Copy it again from Hamnivo Studio.', 'hamnivo-chat' ) );
		}

		if ( '1' === self::text( $input, 'identity_secret_clear' ) ) {
			$clean['identity_secret'] = '';
		}
		$secret = trim( self::text( $input, 'identity_secret' ) );
		if ( '' !== $secret ) {
			$clean['identity_secret'] = $secret;
		}

		// A key that cannot sign is refused now, with the reason, instead of failing for customers.
		if ( '1' === $clean['identity'] && '' !== $secret && Identity::sdk_available() ) {
			$problem = Identity::key_problem( $clean['identity_kid'], $secret );
			if ( null !== $problem ) {
				$clean['identity_secret'] = self::get( 'identity_secret' );
				self::complain( 'identity_secret', $problem );
			}
		}

		return $clean;
	}

	/**
	 * The values of a settings form or of a test request, cleaned the same way as when saving, but
	 * without saving or complaining.
	 *
	 * @param array<string,mixed> $input Unslashed form values.
	 * @return array<string,string> widget_id, chat_url and api_url, empty where they do not fit.
	 */
	public static function addresses_from( array $input ): array {
		$input = self::fill_from_install_code( $input );
		$id    = trim( sanitize_text_field( self::text( $input, 'widget_id' ) ) );
		$chat  = self::address( self::text( $input, 'chat_url' ), true );
		$api   = self::address( self::text( $input, 'api_url' ), false );
		return array(
			'widget_id' => self::is_widget_id( $id ) ? $id : '',
			'chat_url'  => null === $chat ? '' : $chat,
			'api_url'   => null === $api ? '' : $api,
		);
	}

	/**
	 * Reads the three values out of the install code that Hamnivo Studio shows: a script tag with
	 * the loader's address, data-widget-id and data-api.
	 *
	 * @param string $code The pasted text.
	 * @return array<string,string> The values it holds, under widget_id, chat_url and api_url.
	 */
	public static function parse_install_code( string $code ): array {
		$found     = array();
		$read      = static function ( string $attribute ) use ( $code ): string {
			$pattern = '/(?<![\w-])' . preg_quote( $attribute, '/' ) . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/i';
			if ( ! preg_match( $pattern, $code, $match ) ) {
				return '';
			}
			return trim( html_entity_decode( '' !== $match[1] ? $match[1] : ( isset( $match[2] ) ? $match[2] : '' ) ) );
		};
		$widget_id = $read( 'data-widget-id' );
		if ( '' !== $widget_id ) {
			$found['widget_id'] = $widget_id;
		}
		$src = $read( 'src' );
		if ( '' !== $src ) {
			$found['chat_url'] = $src;
		}
		$api = $read( 'data-api' );
		if ( '' !== $api ) {
			$found['api_url'] = $api;
		}
		return $found;
	}

	/**
	 * Whether text is a widget ID.
	 *
	 * @param string $text Text to check.
	 */
	public static function is_widget_id( string $text ): bool {
		return 1 === preg_match( '/^wid_[0-9a-z]{26}$/', $text );
	}

	/**
	 * Fills the empty address fields from a pasted install code.
	 *
	 * @param array<string,mixed> $input Form values.
	 * @return array<string,mixed>
	 */
	private static function fill_from_install_code( array $input ): array {
		$code = trim( self::text( $input, 'install_code' ) );
		if ( '' === $code ) {
			return $input;
		}
		foreach ( self::parse_install_code( $code ) as $key => $value ) {
			if ( '' === trim( self::text( $input, $key ) ) ) {
				$input[ $key ] = $value;
			}
		}
		return $input;
	}

	/**
	 * A web address, made ready to store. The chat address is only a website's origin, because the
	 * loader finds the chat app at the origin of its own address. The API address may have a path.
	 *
	 * @param string $raw        What was typed.
	 * @param bool   $origin_only Keep only the scheme, host and port.
	 * @return string|null The address, an empty string for nothing, or null when it does not fit.
	 */
	private static function address( string $raw, bool $origin_only ) {
		$raw = trim( $raw );
		if ( '' === $raw ) {
			return '';
		}
		// A web address has no spaces. Without this, esc_url would turn "not a url" into https://not%20a%20url.
		if ( preg_match( '/\s/', $raw ) ) {
			return null;
		}
		$url = esc_url_raw( $raw, array( 'https', 'http' ) );
		if ( '' === $url ) {
			return null;
		}
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) || ! self::is_host( $parts['host'] ) ) {
			return null;
		}
		$origin = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
		if ( $origin_only ) {
			return $origin;
		}
		return untrailingslashit( $origin . ( isset( $parts['path'] ) ? $parts['path'] : '' ) );
	}

	/**
	 * Whether text is a host name, an IPv4 address or a bracketed IPv6 address.
	 *
	 * @param string $host The host of an address.
	 */
	private static function is_host( string $host ): bool {
		return 1 === preg_match( '/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i', $host )
			|| 1 === preg_match( '/^\[[0-9a-f:.]+\]$/i', $host );
	}

	/**
	 * A form value as text.
	 *
	 * @param array<string,mixed> $input Form values.
	 * @param string              $key   The field.
	 */
	private static function text( array $input, string $key ): string {
		return isset( $input[ $key ] ) && is_scalar( $input[ $key ] ) ? (string) $input[ $key ] : '';
	}

	/**
	 * Tells the person on the settings page what to fix.
	 *
	 * @param string $code    Which field.
	 * @param string $message What to do.
	 */
	private static function complain( string $code, string $message ): void {
		add_settings_error( self::OPTION, $code, $message );
	}
}
