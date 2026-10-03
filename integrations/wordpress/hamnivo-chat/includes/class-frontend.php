<?php
/**
 * What visitors get: the chat loader on every public page, and the script that verifies customers.
 *
 * @package Hamnivo_Chat
 */

namespace Hamnivo\Chat;

defined( 'ABSPATH' ) || exit;

/**
 * Prints the loader script and, when verified customers are on, the small script that passes the
 * assertion to the chat and signs the chat out with the site.
 */
final class Frontend {

	const IDENTITY_HANDLE = 'hamnivo-chat-identity';

	/**
	 * Hooks into the public pages.
	 */
	public static function hooks(): void {
		add_action( 'wp_footer', array( __CLASS__, 'print_loader' ), 20 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue_identity' ) );
	}

	/**
	 * Whether this request is a page that gets the chat: set up, public, and not a feed, an embed,
	 * the customizer preview or an AJAX call.
	 */
	public static function should_load(): bool {
		$load = Settings::is_configured()
			&& ! is_admin()
			&& ! is_feed()
			&& ! is_embed()
			&& ! is_customize_preview()
			&& ! wp_doing_ajax();

		/**
		 * Turns the chat off (or on) for a page. For example, to hide it on the checkout:
		 * add_filter( 'hamnivo_chat_should_load', fn ( $load ) => $load && ! is_checkout() );
		 *
		 * @param bool $load Whether this page gets the chat.
		 */
		return (bool) apply_filters( 'hamnivo_chat_should_load', $load );
	}

	/**
	 * The attributes of the loader's script tag.
	 *
	 * @return array<string,string|bool>
	 */
	public static function loader_attributes(): array {
		$attributes = array(
			'src'            => Settings::get( 'chat_url' ) . '/loader.js',
			'data-widget-id' => Settings::get( 'widget_id' ),
			'async'          => true,
		);
		if ( '' !== Settings::get( 'api_url' ) ) {
			$attributes['data-api'] = Settings::get( 'api_url' );
		}
		return $attributes;
	}

	/**
	 * Prints the loader before the closing body tag. wp_print_script_tag escapes every attribute and
	 * applies the wp_script_attributes filter, which is where a security plugin adds a CSP nonce.
	 */
	public static function print_loader(): void {
		if ( ! self::should_load() ) {
			return;
		}
		wp_print_script_tag( self::loader_attributes() );
	}

	/**
	 * Adds the identity script to public pages when verified customers are on.
	 */
	public static function enqueue_identity(): void {
		if ( ! self::should_load() || ! Identity::is_ready() ) {
			return;
		}
		$logged_in = is_user_logged_in();
		$config    = array(
			'loggedIn' => $logged_in,
			'endpoint' => rest_url( Identity::REST_NAMESPACE . Identity::REST_ROUTE ),
			'nonce'    => $logged_in ? wp_create_nonce( 'wp_rest' ) : '',
		);
		wp_register_script( self::IDENTITY_HANDLE, HAMNIVO_CHAT_URL . 'assets/identity.js', array(), HAMNIVO_CHAT_VERSION, true );
		wp_add_inline_script(
			self::IDENTITY_HANDLE,
			'window.HamnivoChatIdentity = ' . wp_json_encode( $config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT ) . ';',
			'before'
		);
		wp_enqueue_script( self::IDENTITY_HANDLE );
	}
}
