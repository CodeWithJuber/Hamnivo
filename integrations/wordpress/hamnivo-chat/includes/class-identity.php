<?php
/**
 * Verified customers: signing the identity assertion for the signed-in WordPress user.
 *
 * @package Hamnivo_Chat
 */

namespace Hamnivo\Chat;

defined( 'ABSPATH' ) || exit;

/**
 * Tells Hamnivo who is signed in to this site. The page asks this plugin's REST route for a
 * short-lived assertion, signed here with the key registered in Hamnivo, and hands it to the chat.
 * Only the server signs, and the customer always comes from the WordPress session, never from the
 * request. It uses the bundled hamnivo/hamnivo-php SDK, which needs PHP 8.1. On older PHP the chat
 * still works and customers stay anonymous.
 */
final class Identity {

	const REST_NAMESPACE = 'hamnivo-chat/v1';
	const REST_ROUTE     = '/identity';

	/**
	 * Registers the REST route.
	 */
	public static function hooks(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Loads the bundled SDK. It is false when this PHP is too old or the SDK files are missing, for
	 * example when the plugin was copied from the repository instead of the zip.
	 */
	public static function sdk_available(): bool {
		if ( PHP_VERSION_ID < 80100 ) {
			return false;
		}
		if ( ! function_exists( 'Hamnivo\\createIdentityAssertion' ) ) {
			$autoload = HAMNIVO_CHAT_DIR . 'lib/hamnivo-php/autoload.php';
			if ( ! is_readable( $autoload ) ) {
				return false;
			}
			require_once $autoload;
		}
		return function_exists( 'Hamnivo\\createIdentityAssertion' );
	}

	/**
	 * Why verified customers cannot work here, in words for the settings page. Null when they can.
	 */
	public static function unavailable_reason(): ?string {
		if ( PHP_VERSION_ID < 80100 ) {
			return sprintf(
				/* translators: %s: the PHP version of this site, such as 7.4.33 */
				__( 'Verified customers need PHP 8.1 or newer, and this site runs PHP %s. The chat itself works. Ask your host to move the site to a newer PHP.', 'hamnivo-chat' ),
				PHP_VERSION
			);
		}
		if ( ! self::sdk_available() ) {
			return __( 'The SDK that signs identities is missing from this copy of the plugin. Install the plugin again from the zip file.', 'hamnivo-chat' );
		}
		return null;
	}

	/**
	 * Verified customers are on, the key is set and the SDK can sign.
	 */
	public static function is_ready(): bool {
		return '1' === Settings::get( 'identity' )
			&& '' !== Settings::get( 'identity_kid' )
			&& '' !== Settings::identity_secret()
			&& self::sdk_available();
	}

	/**
	 * The key in the form the SDK takes. A secret is HS256. A private key in JSON (a JWK) is ES256,
	 * EdDSA or RS256, whichever its type says.
	 *
	 * @param string $kid    The key ID registered in Hamnivo.
	 * @param string $secret The secret, or the private key as JSON.
	 * @return array<string,mixed>|null Null when the key is JSON that is not a private key Hamnivo takes.
	 */
	public static function key_for( string $kid, string $secret ): ?array {
		if ( 0 !== strpos( ltrim( $secret ), '{' ) ) {
			return array(
				'kid'    => $kid,
				'alg'    => 'HS256',
				'secret' => $secret,
			);
		}
		$jwk = json_decode( $secret, true );
		if ( ! is_array( $jwk ) ) {
			return null;
		}
		$kty = isset( $jwk['kty'] ) ? $jwk['kty'] : '';
		$crv = isset( $jwk['crv'] ) ? $jwk['crv'] : '';
		if ( 'EC' === $kty && 'P-256' === $crv ) {
			$alg = 'ES256';
		} elseif ( 'OKP' === $kty && 'Ed25519' === $crv ) {
			$alg = 'EdDSA';
		} elseif ( 'RSA' === $kty ) {
			$alg = 'RS256';
		} else {
			return null;
		}
		return array(
			'kid'        => $kid,
			'alg'        => $alg,
			'privateKey' => $jwk,
		);
	}

	/**
	 * Signs a test assertion to see whether the key works. The SDK's messages never repeat the key,
	 * so they are safe to show.
	 *
	 * @param string $kid    The key ID.
	 * @param string $secret The secret or the private key.
	 * @return string|null What to fix, or null when the key can sign.
	 */
	public static function key_problem( string $kid, string $secret ): ?string {
		if ( ! self::sdk_available() ) {
			return self::unavailable_reason();
		}
		$key = self::key_for( $kid, $secret );
		if ( null === $key ) {
			return __( 'The key looks like JSON, but it is not a private key that Hamnivo accepts (ES256, EdDSA or RS256). Paste the HS256 secret, or the private key as Hamnivo Studio or @hamnivo/server made it.', 'hamnivo-chat' );
		}
		try {
			\Hamnivo\createIdentityAssertion(
				array(
					'widgetId' => 'wid_00000000000000000000000000',
					'key'      => $key,
					'customer' => array( 'id' => 'hamnivo-wordpress-test' ),
				)
			);
		} catch ( \Hamnivo\HamnivoIdentityError $error ) {
			return $error->getMessage();
		}
		return null;
	}

	/**
	 * The customer for a user, from WordPress's own records. For a WooCommerce customer the billing
	 * name is preferred, because that is how the shop knows them.
	 *
	 * The email is sent only when the site says it has confirmed addresses, because Hamnivo keeps
	 * an email only for a verified one. Send less, share less.
	 *
	 * @param \WP_User $user The signed-in user.
	 * @return array<string,mixed> The SDK's customer.
	 */
	public static function customer_for( \WP_User $user ): array {
		$customer = array( 'id' => (string) $user->ID );

		$name = self::name_for( $user );
		if ( '' !== $name ) {
			$customer['name'] = $name;
		}

		/**
		 * Whether this user's email address is confirmed. A site that makes people confirm their
		 * email before they can sign in can turn this on in the settings.
		 *
		 * @param bool     $verified Whether the address is confirmed.
		 * @param \WP_User $user     The user.
		 */
		$verified = (bool) apply_filters( 'hamnivo_chat_email_verified', '1' === Settings::get( 'trust_emails' ), $user );
		if ( $verified && '' !== $user->user_email ) {
			$customer['email']         = $user->user_email;
			$customer['emailVerified'] = true;
		}

		/**
		 * Changes the customer before it is signed. Take the values from your own records, never from
		 * the request. The id must stay the same for the same person.
		 *
		 * @param array<string,mixed> $customer id, name, email and emailVerified.
		 * @param \WP_User            $user     The user.
		 */
		$filtered = apply_filters( 'hamnivo_chat_customer', $customer, $user );
		if ( is_array( $filtered ) && isset( $filtered['id'] ) ) {
			$customer = $filtered;
		}

		if ( isset( $customer['name'] ) && is_string( $customer['name'] ) ) {
			$customer['name'] = self::shorten( $customer['name'], 120 );
		}
		return $customer;
	}

	/**
	 * An assertion for a user, ready to send to the page.
	 *
	 * @param \WP_User $user The signed-in user.
	 * @return string|\WP_Error
	 */
	public static function assertion_for( \WP_User $user ) {
		$failure = new \WP_Error(
			'hamnivo_chat_identity',
			__( 'The chat could not verify you right now.', 'hamnivo-chat' ),
			array( 'status' => 500 )
		);
		if ( ! self::is_ready() ) {
			return $failure;
		}
		$key = self::key_for( Settings::get( 'identity_kid' ), Settings::identity_secret() );
		if ( null === $key ) {
			return $failure;
		}
		$customer = self::customer_for( $user );
		$options  = array(
			'widgetId' => Settings::get( 'widget_id' ),
			'key'      => $key,
			'customer' => $customer,
		);
		try {
			return \Hamnivo\createIdentityAssertion( $options );
		} catch ( \Hamnivo\HamnivoIdentityError $error ) {
			// Hamnivo refuses an address its pattern does not accept. Chat without the email then.
			unset( $options['customer']['email'], $options['customer']['emailVerified'] );
			try {
				return \Hamnivo\createIdentityAssertion( $options );
			} catch ( \Hamnivo\HamnivoIdentityError $second ) {
				return $failure;
			}
		}
	}

	/**
	 * Registers the route the page asks for an assertion.
	 */
	public static function register_routes(): void {
		register_rest_route(
			self::REST_NAMESPACE,
			self::REST_ROUTE,
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'rest_assertion' ),
				'permission_callback' => array( __CLASS__, 'rest_permission' ),
			)
		);
	}

	/**
	 * Only signed-in users. WordPress treats a cookie request without its REST nonce as signed out,
	 * so a page on another website cannot make a visitor's browser ask for an assertion.
	 *
	 * @return bool|\WP_Error
	 */
	public static function rest_permission() {
		if ( is_user_logged_in() ) {
			return true;
		}
		return new \WP_Error(
			'hamnivo_chat_signed_out',
			__( 'Sign in first.', 'hamnivo-chat' ),
			array( 'status' => 401 )
		);
	}

	/**
	 * Answers with a fresh assertion for the signed-in user, which no cache may keep.
	 *
	 * @return \WP_REST_Response|\WP_Error
	 */
	public static function rest_assertion() {
		$assertion = self::assertion_for( wp_get_current_user() );
		if ( is_wp_error( $assertion ) ) {
			return $assertion;
		}
		$response = new \WP_REST_Response( array( 'assertion' => $assertion ) );
		$response->header( 'Cache-Control', 'no-store' );
		return $response;
	}

	/**
	 * The name Hamnivo shows to staff.
	 *
	 * @param \WP_User $user The user.
	 */
	private static function name_for( \WP_User $user ): string {
		$billing = trim( (string) get_user_meta( $user->ID, 'billing_first_name', true ) . ' ' . (string) get_user_meta( $user->ID, 'billing_last_name', true ) );
		foreach ( array( $billing, trim( (string) $user->display_name ), trim( (string) $user->user_login ) ) as $name ) {
			if ( '' !== $name ) {
				return self::shorten( $name, 120 );
			}
		}
		return '';
	}

	/**
	 * Cuts text to at most this many UTF-16 units, which is how Hamnivo counts a name, without
	 * splitting a character.
	 *
	 * @param string $text  The text.
	 * @param int    $units The most units to keep.
	 */
	private static function shorten( string $text, int $units ): string {
		$characters = preg_split( '//u', $text, -1, PREG_SPLIT_NO_EMPTY );
		if ( false === $characters ) {
			return '';
		}
		$kept  = '';
		$count = 0;
		foreach ( $characters as $character ) {
			$count += strlen( $character ) >= 4 ? 2 : 1;
			if ( $count > $units ) {
				break;
			}
			$kept .= $character;
		}
		return $kept;
	}
}
