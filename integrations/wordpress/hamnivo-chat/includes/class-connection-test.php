<?php
/**
 * The "Test connection" button: what it checks, and what it tells the person.
 *
 * @package Hamnivo_Chat
 */

namespace Hamnivo\Chat;

defined( 'ABSPATH' ) || exit;

/**
 * Asks the chat address for its loader and the API for the widget, the way a visitor's browser
 * would, and says in plain words what is wrong. It only reads. Nothing is created in Hamnivo.
 */
final class Connection_Test {

	/**
	 * Runs the checks.
	 *
	 * @param array<string,string> $values widget_id, chat_url and api_url, as Settings::addresses_from() gives them.
	 * @return array{ok:bool,checks:array<int,array{ok:bool,label:string,detail:string}>}
	 */
	public static function run( array $values ): array {
		$checks   = array();
		$checks[] = self::check_widget_id( $values['widget_id'] );
		$checks[] = self::check_chat( $values['chat_url'] );
		$checks[] = self::check_api( $values['api_url'], $values['widget_id'] );
		if ( '1' === Settings::get( 'identity' ) ) {
			$checks[] = self::check_identity();
		}

		$ok = true;
		foreach ( $checks as $check ) {
			$ok = $ok && $check['ok'];
		}
		return array(
			'ok'     => $ok,
			'checks' => $checks,
		);
	}

	/**
	 * The origin the visitors' browsers send: the scheme, host and port of the site's home page.
	 */
	public static function site_origin(): string {
		$parts = wp_parse_url( home_url() );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		return $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' );
	}

	/**
	 * Whether the widget ID has the right shape.
	 *
	 * @param string $widget_id The widget ID, or an empty string when it did not fit.
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function check_widget_id( string $widget_id ): array {
		if ( '' === $widget_id ) {
			return self::fail(
				__( 'Widget ID', 'hamnivo-chat' ),
				__( 'Enter the widget ID. It is wid_ followed by 26 lowercase letters and digits.', 'hamnivo-chat' )
			);
		}
		return self::pass( __( 'Widget ID', 'hamnivo-chat' ), __( 'The widget ID has the right shape.', 'hamnivo-chat' ) );
	}

	/**
	 * Whether the chat address serves the loader.
	 *
	 * @param string $chat_url The chat address.
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function check_chat( string $chat_url ): array {
		$label = __( 'Chat address', 'hamnivo-chat' );
		if ( '' === $chat_url ) {
			return self::fail( $label, __( 'Enter the chat address, for example https://chat.example.com.', 'hamnivo-chat' ) );
		}
		if ( 0 === strpos( $chat_url, 'http://' ) && 0 === strpos( home_url(), 'https://' ) ) {
			return self::fail( $label, __( 'The chat address starts with http://, but this site uses https://. Browsers block the chat then. Use the https:// address.', 'hamnivo-chat' ) );
		}
		$response = self::get( $chat_url . '/loader.js', array() );
		if ( is_wp_error( $response ) ) {
			return self::fail(
				$label,
				sprintf(
					/* translators: %s: the reason, in English, such as "cURL error 6: Could not resolve host". */
					__( 'This site could not reach the chat address. %s', 'hamnivo-chat' ),
					$response->get_error_message()
				)
			);
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( 200 !== $code ) {
			return self::fail(
				$label,
				sprintf(
					/* translators: %d: an HTTP status such as 404 */
					__( 'The chat address answered with status %d instead of the loader. Check the address.', 'hamnivo-chat' ),
					$code
				)
			);
		}
		if ( false === strpos( wp_remote_retrieve_body( $response ), 'Hamnivo' ) ) {
			return self::fail( $label, __( 'The address answered, but what it sent is not the Hamnivo loader. Check the address.', 'hamnivo-chat' ) );
		}
		return self::pass( $label, __( 'The chat address serves the loader.', 'hamnivo-chat' ) );
	}

	/**
	 * Whether the API knows the widget and lets this site use it. The request carries this site's
	 * origin, which is what the visitor's browser sends and what the brand's allowed websites list is
	 * checked against.
	 *
	 * @param string $api_url   The API address.
	 * @param string $widget_id The widget ID.
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function check_api( string $api_url, string $widget_id ): array {
		$label = __( 'API address and allowed website', 'hamnivo-chat' );
		if ( '' === $api_url ) {
			return self::pass( $label, __( 'No API address is set, so the chat uses its own default. Nothing to check here.', 'hamnivo-chat' ) );
		}
		if ( '' === $widget_id ) {
			return self::fail( $label, __( 'Enter a valid widget ID first.', 'hamnivo-chat' ) );
		}
		if ( 0 === strpos( $api_url, 'http://' ) && 0 === strpos( home_url(), 'https://' ) ) {
			return self::fail( $label, __( 'The API address starts with http://, but this site uses https://. Browsers block it then. Use the https:// address.', 'hamnivo-chat' ) );
		}
		$origin   = self::site_origin();
		$response = self::get(
			add_query_arg( 'widgetId', rawurlencode( $widget_id ), $api_url . '/v1/widget/launcher' ),
			array(
				'Origin' => $origin,
				'Accept' => 'application/json',
			)
		);
		if ( is_wp_error( $response ) ) {
			return self::fail(
				$label,
				sprintf(
					/* translators: %s: the reason, in English, such as "cURL error 6: Could not resolve host". */
					__( 'This site could not reach the API address. %s', 'hamnivo-chat' ),
					$response->get_error_message()
				)
			);
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = json_decode( wp_remote_retrieve_body( $response ), true );
		$body = is_array( $body ) ? $body : array();
		if ( 200 === $code && isset( $body['widgetId'] ) && $body['widgetId'] === $widget_id ) {
			return self::pass(
				$label,
				sprintf(
					/* translators: %s: this website's address, such as https://shop.example.com */
					__( 'Hamnivo knows this widget ID and allows %s to use it.', 'hamnivo-chat' ),
					$origin
				)
			);
		}
		if ( 403 === $code && isset( $body['code'] ) && 'ORIGIN_NOT_ALLOWED' === $body['code'] ) {
			return self::fail(
				$label,
				sprintf(
					/* translators: %s: this website's address, such as https://shop.example.com */
					__( 'Hamnivo knows this widget ID, but %s is not in the brand\'s allowed websites. In Hamnivo Studio, open the brand and add this address to its allowed websites. The chat opens only there.', 'hamnivo-chat' ),
					$origin
				)
			);
		}
		if ( 404 === $code ) {
			return self::fail( $label, __( 'Hamnivo does not know this widget ID, or the brand is not active. Check the widget ID, and that the API address belongs to the same Hamnivo as the chat address.', 'hamnivo-chat' ) );
		}
		return self::fail(
			$label,
			sprintf(
				/* translators: %d: an HTTP status such as 500 */
				__( 'The API answered with status %d. Check the API address.', 'hamnivo-chat' ),
				$code
			)
		);
	}

	/**
	 * Whether the identity key can sign. It is checked here, on this server, so nothing is sent.
	 *
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function check_identity(): array {
		$label  = __( 'Verified customers', 'hamnivo-chat' );
		$secret = Settings::identity_secret();
		if ( '' === Settings::get( 'identity_kid' ) || '' === $secret ) {
			return self::fail( $label, __( 'Verified customers are on, but the key ID or the key is empty.', 'hamnivo-chat' ) );
		}
		$problem = Identity::key_problem( Settings::get( 'identity_kid' ), $secret );
		if ( null !== $problem ) {
			return self::fail( $label, $problem );
		}
		return self::pass( $label, __( 'The key works. Signed-in customers will be verified.', 'hamnivo-chat' ) );
	}

	/**
	 * A GET request that WordPress considers safe: it refuses addresses on private networks. When a
	 * request fails because of that, or because the name does not exist, it says so in plain words.
	 *
	 * @param string               $url     The address.
	 * @param array<string,string> $headers Extra headers.
	 * @return array<string,mixed>|\WP_Error
	 */
	private static function get( string $url, array $headers ) {
		$args     = array(
			'timeout'     => 8,
			'redirection' => 3,
			'user-agent'  => 'HamnivoChat-WordPress/' . HAMNIVO_CHAT_VERSION . '; ' . home_url(),
			'headers'     => $headers,
		);
		$response = wp_safe_remote_get( $url, $args );
		if ( is_wp_error( $response ) && ! wp_http_validate_url( $url ) ) {
			return self::unsafe_address( $url );
		}
		return $response;
	}

	/**
	 * Why WordPress would not call an address: its name does not exist, or it is on a private
	 * network or an unusual port.
	 *
	 * @param string $url The address.
	 */
	private static function unsafe_address( string $url ): \WP_Error {
		$host = (string) wp_parse_url( $url, PHP_URL_HOST );
		if ( false === filter_var( $host, FILTER_VALIDATE_IP ) && gethostbyname( $host ) === $host ) {
			return new \WP_Error(
				'hamnivo_chat_unknown_host',
				__( 'This site could not find that address. Check it for typing mistakes.', 'hamnivo-chat' )
			);
		}
		return new \WP_Error(
			'hamnivo_chat_unsafe_address',
			__( 'WordPress does not let a site call an address on a private network or on an unusual port. Your visitors\' browsers can still reach it.', 'hamnivo-chat' )
		);
	}

	/**
	 * A check that passed.
	 *
	 * @param string $label  What was checked.
	 * @param string $detail What it found.
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function pass( string $label, string $detail ): array {
		return array(
			'ok'     => true,
			'label'  => $label,
			'detail' => $detail,
		);
	}

	/**
	 * A check that failed.
	 *
	 * @param string $label  What was checked.
	 * @param string $detail What is wrong and what to do.
	 * @return array{ok:bool,label:string,detail:string}
	 */
	private static function fail( string $label, string $detail ): array {
		return array(
			'ok'     => false,
			'label'  => $label,
			'detail' => $detail,
		);
	}
}
