<?php
/**
 * The Hamnivo Chat plugin, tested inside WordPress. Run by tests/plugin.test.mjs in WordPress
 * Playground, on each PHP version. The plugin must be active and mounted at PLUGIN_DIR, and the
 * PHP SDK fixtures at /fixtures (they hold throwaway keys for every algorithm).
 *
 * The suite is plain PHP 7.4. On PHP before 8.1 the identity tests check that the chat still works
 * and that the settings page says why customers cannot be verified.
 */

require __DIR__ . '/harness.php';

use Hamnivo\Chat\Admin;
use Hamnivo\Chat\Connection_Test;
use Hamnivo\Chat\Frontend;
use Hamnivo\Chat\Identity;
use Hamnivo\Chat\Settings;

const SECRET   = 'q3Zp0xv9L2m8Yk1T5bN7cR4dWf6HjA0sEuG-iO_hXzo';
const WIDGET   = 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce';
const INSTALL  = '<script src="https://chat.example.com/loader.js" data-widget-id="wid_01j9zk7w3xq8r4t2v6m5n1p0ce" data-api="https://api.example.com" async></script>';
$php81         = PHP_VERSION_ID >= 80100;
$fixtures      = is_readable( '/fixtures/identity.json' ) ? json_decode( (string) file_get_contents( '/fixtures/identity.json' ), true ) : null;

/** Signs in as a new administrator. */
function sign_in_as_admin(): WP_User {
	$admin = make_user( array( 'role' => 'administrator' ) );
	wp_set_current_user( $admin->ID );
	return $admin;
}

/** Settings that turn verified customers on, with the HS256 secret. */
function identity_on( array $more = array() ): void {
	configure( array_merge( array( 'identity' => '1', 'identity_kid' => 'shop-2026', 'identity_secret' => SECRET ), $more ) );
}

// ---------------------------------------------------------------- the plugin

test( 'the plugin is active, and its classes and constants are loaded', function () {
	truthy( in_array( 'hamnivo-chat/hamnivo-chat.php', (array) get_option( 'active_plugins' ), true ), 'the plugin is active' );
	same( '0.2.0', HAMNIVO_CHAT_VERSION );
	truthy( class_exists( Settings::class ) && class_exists( Frontend::class ) && class_exists( Identity::class ) && class_exists( Admin::class ), 'classes' );
	same( PLUGIN_DIR . '/', HAMNIVO_CHAT_DIR );
} );

test( 'the plugin reads as a plugin: name, version, text domain and requirements', function () {
	$data = get_plugin_data( PLUGIN_DIR . '/hamnivo-chat.php', false, false );
	same( 'Hamnivo Chat', $data['Name'] );
	same( '0.2.0', $data['Version'] );
	same( 'hamnivo-chat', $data['TextDomain'] );
	same( '/languages', $data['DomainPath'] );
	same( '7.4', $data['RequiresPHP'] );
	same( '6.0', $data['RequiresWP'] );
	truthy( is_readable( PLUGIN_DIR . '/languages/hamnivo-chat.pot' ), 'the translation template' );
} );

// ---------------------------------------------------------------- the loader

test( 'prints nothing until the widget ID and the chat address are set', function () {
	lacks( 'loader.js', page_footer() );
	configure( array( 'chat_url' => '' ) );
	lacks( 'loader.js', page_footer(), 'without a chat address' );
	configure( array( 'widget_id' => '' ) );
	lacks( 'loader.js', page_footer(), 'without a widget ID' );
} );

test( 'prints the loader once, with the widget ID and the API address', function () {
	configure();
	$out = page_footer();
	same( 1, substr_count( $out, 'loader.js' ), 'once' );
	contains( 'src="https://chat.example.com/loader.js"', $out );
	contains( 'data-widget-id="' . WIDGET . '"', $out );
	contains( 'data-api="https://api.example.com"', $out );
	truthy( 1 === preg_match( '/<script[^>]*\sasync[\s>]/', $out ), 'it is async' );
} );

test( 'leaves out data-api when there is no API address', function () {
	configure( array( 'api_url' => '' ) );
	lacks( 'data-api', page_footer() );
} );

test( 'escapes every attribute, so a bad value cannot break out of the tag', function () {
	configure(
		array(
			'widget_id' => 'wid_x" onerror="alert(1)',
			'chat_url'  => 'https://chat.example.com/"><script>alert(2)</script>',
			'api_url'   => "https://api.example.com/'><img src=x onerror=alert(3)>",
		)
	);
	$out = page_footer();
	lacks( '"><script>alert(2)', $out );
	lacks( 'onerror="alert(1)"', $out );
	lacks( '<img src=x', $out );
	contains( '&quot;', $out );
	same( 1, substr_count( $out, 'loader.js' ), 'still one tag' );
} );

test( 'lets a security plugin add a CSP nonce to the tag', function () {
	configure();
	add_filter(
		'wp_script_attributes',
		function ( $attributes ) {
			if ( isset( $attributes['data-widget-id'] ) ) {
				$attributes['nonce'] = 'abc123';
			}
			return $attributes;
		}
	);
	contains( 'nonce="abc123"', page_footer() );
} );

test( 'can be turned off for a page with the hamnivo_chat_should_load filter', function () {
	configure();
	add_filter( 'hamnivo_chat_should_load', '__return_false' );
	lacks( 'loader.js', page_footer() );
} );

test( 'stays off in the admin, in feeds, in embeds and in AJAX calls', function () {
	configure();
	set_current_screen( 'dashboard' );
	lacks( 'loader.js', page_footer(), 'admin' );
	unset( $GLOBALS['current_screen'] );

	global $wp_query;
	$wp_query->is_feed = true;
	lacks( 'loader.js', page_footer(), 'feed' );
	$wp_query->is_feed  = false;
	$wp_query->is_embed = true;
	lacks( 'loader.js', page_footer(), 'embed' );
	$wp_query->is_embed = false;

	add_filter( 'wp_doing_ajax', '__return_true' );
	lacks( 'loader.js', page_footer(), 'AJAX' );
	remove_all_filters( 'wp_doing_ajax' );
	contains( 'loader.js', page_footer(), 'and on again for a page' );
} );

// ---------------------------------------------------------------- settings

test( 'keeps the chat address to its origin and the API address to its path, without trailing slashes', function () {
	$clean = Settings::sanitize(
		array(
			'widget_id' => ' ' . WIDGET . ' ',
			'chat_url'  => 'https://chat.example.com:8443/loader.js?x=1#top',
			'api_url'   => 'https://example.com/hamnivo/api/',
		)
	);
	same( WIDGET, $clean['widget_id'] );
	same( 'https://chat.example.com:8443', $clean['chat_url'] );
	same( 'https://example.com/hamnivo/api', $clean['api_url'] );
	same( array(), get_settings_errors( 'hamnivo_chat' ), 'no complaints' );
} );

test( 'keeps the saved value and says what is wrong when a widget ID or an address does not fit', function () {
	configure();
	$clean = Settings::sanitize(
		array(
			'widget_id' => 'brd_01j9zk7w3xq8r4t2v6m5n1p0ce',
			'chat_url'  => 'javascript:alert(1)',
			'api_url'   => 'ftp://api.example.com',
		)
	);
	same( WIDGET, $clean['widget_id'], 'widget ID kept' );
	same( 'https://chat.example.com', $clean['chat_url'], 'chat address kept' );
	same( 'https://api.example.com', $clean['api_url'], 'API address kept' );
	$codes = array_column( get_settings_errors( 'hamnivo_chat' ), 'code' );
	sort( $codes );
	same( array( 'api_url', 'chat_url', 'widget_id' ), $codes );
} );

test( 'lets an empty field mean "none"', function () {
	configure();
	$clean = Settings::sanitize( array( 'widget_id' => '', 'chat_url' => '', 'api_url' => '' ) );
	same( '', $clean['widget_id'] );
	same( '', $clean['chat_url'] );
	same( '', $clean['api_url'] );
} );

test( 'saves only its own settings', function () {
	$clean = Settings::sanitize( array( 'widget_id' => WIDGET, 'evil' => 'x', 'admin' => '1' ) );
	same( array_keys( Settings::defaults() ), array_keys( $clean ) );
} );

test( 'reads the three values from the install code of Hamnivo Studio', function () {
	same(
		array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com/loader.js', 'api_url' => 'https://api.example.com' ),
		Settings::parse_install_code( INSTALL )
	);
	$clean = Settings::sanitize( array( 'install_code' => INSTALL ) );
	same( WIDGET, $clean['widget_id'] );
	same( 'https://chat.example.com', $clean['chat_url'], 'the loader address becomes the chat origin' );
	same( 'https://api.example.com', $clean['api_url'] );
} );

test( 'reads an install code in single quotes, on several lines, and ignores text that is not one', function () {
	$code = "<script\n  async\n  src='https://chat.example.com/loader.js'\n  data-widget-id='" . WIDGET . "'\n></script>";
	same( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com/loader.js' ), Settings::parse_install_code( $code ) );
	same( array(), Settings::parse_install_code( 'hello, I could not find my widget id' ) );
	same( array(), Settings::parse_install_code( '<img data-src="https://x.example/a.png" />' ), 'data-src is not src' );
} );

test( 'prefers what is typed over what is pasted', function () {
	$clean = Settings::sanitize( array( 'install_code' => INSTALL, 'api_url' => 'https://other.example.com' ) );
	same( 'https://other.example.com', $clean['api_url'] );
	same( WIDGET, $clean['widget_id'] );
} );

test( 'cleans the values of a test the same way as a save, without saving', function () {
	$values = Settings::addresses_from( array( 'install_code' => INSTALL, 'chat_url' => 'not a url' ) );
	same( WIDGET, $values['widget_id'] );
	same( '', $values['chat_url'], 'a bad address is empty, so the test says so' );
	same( 'https://api.example.com', $values['api_url'] );
	same( false, get_option( 'hamnivo_chat' ), 'nothing was saved' );
} );

test( 'cleans values that arrive through the Settings API', function () {
	Admin::register_settings();
	update_option( 'hamnivo_chat', array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com/path/?x=1', 'junk' => 'x' ) );
	$all = Settings::all();
	same( 'https://chat.example.com', $all['chat_url'] );
	truthy( ! array_key_exists( 'junk', (array) get_option( 'hamnivo_chat' ) ), 'junk was dropped' );
	unregister_setting( 'hamnivo_chat', 'hamnivo_chat' );
} );

test( 'keeps a saved identity key when the field is left empty, and removes it on request', function () {
	configure( array( 'identity_secret' => SECRET ) );
	same( SECRET, Settings::sanitize( array( 'identity_secret' => '' ) )['identity_secret'], 'kept' );
	same( '', Settings::sanitize( array( 'identity_secret' => '', 'identity_secret_clear' => '1' ) )['identity_secret'], 'removed' );
	same( 'a-new-secret', Settings::sanitize( array( 'identity_secret' => ' a-new-secret ' ) )['identity_secret'], 'replaced and trimmed' );
} );

test( 'asks for a key ID the gateway can register', function () {
	configure();
	same( 'shop-2026.a_b', Settings::sanitize( array( 'identity_kid' => 'shop-2026.a_b' ) )['identity_kid'] );
	same( '', Settings::sanitize( array( 'identity_kid' => 'a key with spaces' ) )['identity_kid'] );
	same( array( 'identity_kid' ), array_column( get_settings_errors( 'hamnivo_chat' ), 'code' ) );
} );

// ---------------------------------------------------------------- verified customers

test( 'knows whether this PHP can sign identities', function () use ( $php81 ) {
	same( $php81, Identity::sdk_available() );
	if ( $php81 ) {
		same( null, Identity::unavailable_reason() );
		truthy( function_exists( 'Hamnivo\\createIdentityAssertion' ), 'the SDK is loaded' );
	} else {
		contains( 'PHP 8.1', (string) Identity::unavailable_reason() );
		contains( PHP_VERSION, (string) Identity::unavailable_reason() );
		truthy( ! function_exists( 'Hamnivo\\createIdentityAssertion' ), 'the SDK is not loaded on old PHP' );
	}
} );

test( 'on PHP before 8.1 the chat works and customers stay anonymous', function () use ( $php81 ) {
	if ( $php81 ) {
		skip( 'this PHP is 8.1 or newer' );
	}
	identity_on();
	same( false, Identity::is_ready() );
	$out = page_footer();
	contains( 'loader.js', $out );
	lacks( 'identity.js', $out );
	$result = rest_do_request( new WP_REST_Request( 'POST', '/hamnivo-chat/v1/identity' ) );
	same( 401, $result->get_status(), 'signed out' );
	wp_set_current_user( make_user()->ID );
	$result = rest_do_request( new WP_REST_Request( 'POST', '/hamnivo-chat/v1/identity' ) );
	same( 500, $result->get_status(), 'signed in, but PHP is too old' );
	lacks( SECRET, wp_json_encode( $result->get_data() ) );
} );

test( 'builds the customer from the WordPress user, with the name only', function () {
	$user = make_user( array( 'display_name' => 'Ayesha Khan' ) );
	same( array( 'id' => (string) $user->ID, 'name' => 'Ayesha Khan' ), Identity::customer_for( $user ) );
} );

test( 'prefers the billing name of a WooCommerce customer, and falls back to the login', function () {
	$user = make_user( array( 'display_name' => '' ) );
	same( $user->user_login, Identity::customer_for( $user )['name'], 'login' );
	update_user_meta( $user->ID, 'billing_first_name', 'Aisha' );
	update_user_meta( $user->ID, 'billing_last_name', 'Siddiqui' );
	same( 'Aisha Siddiqui', Identity::customer_for( $user )['name'], 'billing name' );
} );

test( 'shares the email only when the site says it confirms addresses', function () {
	$user = make_user();
	truthy( ! isset( Identity::customer_for( $user )['email'] ), 'not by default' );

	configure( array( 'trust_emails' => '1' ) );
	$customer = Identity::customer_for( $user );
	same( $user->user_email, $customer['email'] );
	same( true, $customer['emailVerified'] );

	configure();
	add_filter( 'hamnivo_chat_email_verified', '__return_true' );
	same( $user->user_email, Identity::customer_for( $user )['email'], 'the filter can turn it on' );
} );

test( 'cuts a long name at 120 UTF-16 units without splitting a character', function () {
	$user = make_user( array( 'display_name' => str_repeat( '🙂', 100 ) ) );
	$name = Identity::customer_for( $user )['name'];
	same( 60, preg_match_all( '/./u', $name ), '60 emoji are 120 units' );
	same( 1, preg_match( '//u', $name ), 'still valid UTF-8' );
} );

test( 'lets a developer change the customer, and ignores a filter that returns nonsense', function () {
	$user = make_user();
	add_filter(
		'hamnivo_chat_customer',
		function ( $customer ) {
			$customer['name'] = 'Changed';
			return $customer;
		}
	);
	same( 'Changed', Identity::customer_for( $user )['name'] );
	remove_all_filters( 'hamnivo_chat_customer' );
	add_filter( 'hamnivo_chat_customer', '__return_false' );
	same( (string) $user->ID, Identity::customer_for( $user )['id'] );
} );

test( 'signs an HS256 assertion for the signed-in user that verifies with the secret', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$user      = make_user( array( 'display_name' => 'Ayesha Khan' ) );
	$assertion = Identity::assertion_for( $user );
	truthy( is_string( $assertion ), 'an assertion' );
	$parts = jwt( $assertion );
	same( array( 'alg' => 'HS256', 'kid' => 'shop-2026', 'typ' => 'JWT' ), $parts['header'] );
	same( hash_hmac( 'sha256', $parts['input'], SECRET, true ), $parts['raw'], 'the signature' );
	$claims = $parts['payload'];
	same( (string) $user->ID, $claims['sub'] );
	same( WIDGET, $claims['aud'] );
	same( 'Ayesha Khan', $claims['name'] );
	same( 120, $claims['exp'] - $claims['iat'] );
	truthy( $claims['iat'] <= time() - 4 && $claims['iat'] >= time() - 10, 'iat is five seconds back' );
	truthy( ! isset( $claims['email'] ), 'no email by default' );
	same( array( 'sub', 'aud', 'iat', 'exp', 'jti', 'name' ), array_keys( $claims ) );
	truthy( 1 === preg_match( '/^[A-Za-z0-9_-]{22}$/', $claims['jti'] ), 'a 16-byte jti' );
} );

test( 'includes the email and its confirmation when the site confirms addresses', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on( array( 'trust_emails' => '1' ) );
	$user   = make_user();
	$claims = jwt( Identity::assertion_for( $user ) )['payload'];
	same( $user->user_email, $claims['email'] );
	same( true, $claims['email_verified'] );
} );

test( 'drops an email that Hamnivo refuses, and still signs', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	add_filter(
		'hamnivo_chat_customer',
		function ( $customer ) {
			$customer['email']         = 'not-an-email';
			$customer['emailVerified'] = true;
			return $customer;
		}
	);
	$claims = jwt( Identity::assertion_for( make_user() ) )['payload'];
	truthy( ! isset( $claims['email'] ) && ! isset( $claims['email_verified'] ), 'the email was dropped' );
} );

test( 'gives every assertion a new jti', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$user = make_user();
	$seen = array();
	for ( $i = 0; $i < 20; $i++ ) {
		$seen[ jwt( Identity::assertion_for( $user ) )['payload']['jti'] ] = true;
	}
	same( 20, count( $seen ) );
} );

test( 'signs with a private key in JSON: ES256, EdDSA and RS256', function () use ( $php81, $fixtures ) {
	if ( ! $php81 || ! $fixtures ) {
		skip( 'needs PHP 8.1 and the fixtures' );
	}
	$user = make_user();
	foreach ( array( 'ES256' => 64, 'EdDSA' => 64, 'RS256' => 256 ) as $alg => $length ) {
		$key = $fixtures['keys'][ $alg ];
		identity_on( array( 'identity_kid' => $key['kid'], 'identity_secret' => wp_json_encode( $key['privateJwk'] ) ) );
		$assertion = Identity::assertion_for( $user );
		truthy( is_string( $assertion ), "{$alg} signs" );
		$parts = jwt( $assertion );
		same( $alg, $parts['header']['alg'] );
		same( $key['kid'], $parts['header']['kid'] );
		same( $length, strlen( $parts['raw'] ), "{$alg} signature length" );
		if ( 'EdDSA' === $alg ) {
			truthy( sodium_crypto_sign_verify_detached( $parts['raw'], $parts['input'], b64u( $key['publicJwk']['x'] ) ), 'EdDSA verifies' );
		}
	}
} );

test( 'refuses a key that cannot sign, with a reason that never repeats the key', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	$spaced = Identity::key_problem( 'shop-2026', 'secret with spaces inside' );
	contains( 'spaces or line breaks', (string) $spaced );
	lacks( 'secret with spaces inside', (string) $spaced );
	contains( 'private key that Hamnivo accepts', (string) Identity::key_problem( 'shop-2026', '{"kty":"oct","k":"abc"}' ) );
	contains( 'private key that Hamnivo accepts', (string) Identity::key_problem( 'shop-2026', '{not json' ) );
	same( null, Identity::key_problem( 'shop-2026', SECRET ) );
	contains( 'key.kid', (string) Identity::key_problem( 'a key id', SECRET ) );
} );

test( 'refuses to save a secret the SDK cannot use, and keeps the one that was saved', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$clean = Settings::sanitize( array( 'identity' => '1', 'identity_kid' => 'shop-2026', 'identity_secret' => 'has a space' ) );
	same( SECRET, $clean['identity_secret'] );
	same( array( 'identity_secret' ), array_column( get_settings_errors( 'hamnivo_chat' ), 'code' ) );
} );

test( 'serves a fresh assertion to signed-in users only, and never caches it', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$request  = static function () {
		return rest_do_request( new WP_REST_Request( 'POST', '/hamnivo-chat/v1/identity' ) );
	};
	$signed_out = $request();
	same( 401, $signed_out->get_status(), 'signed out' );
	lacks( 'assertion', wp_json_encode( $signed_out->get_data() ) );

	$user = make_user();
	wp_set_current_user( $user->ID );
	$first = $request();
	same( 200, $first->get_status() );
	same( 'no-store', $first->get_headers()['Cache-Control'] );
	same( (string) $user->ID, jwt( $first->get_data()['assertion'] )['payload']['sub'] );
	truthy( $request()->get_data()['assertion'] !== $first->get_data()['assertion'], 'a new assertion every time' );
} );

test( 'takes the customer from the session, never from the request', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on( array( 'trust_emails' => '1' ) );
	$user    = make_user();
	$other   = make_user( array( 'display_name' => 'Somebody Else' ) );
	wp_set_current_user( $user->ID );
	$request = new WP_REST_Request( 'POST', '/hamnivo-chat/v1/identity' );
	$request->set_body_params( array( 'id' => (string) $other->ID, 'name' => 'Somebody Else', 'email' => 'x@example.com', 'sub' => '1' ) );
	$request->set_query_params( array( 'user' => $other->ID, 'customer' => $other->ID ) );
	$claims  = jwt( rest_do_request( $request )->get_data()['assertion'] )['payload'];
	same( (string) $user->ID, $claims['sub'] );
	same( $user->user_email, $claims['email'] );
	truthy( 'Somebody Else' !== $claims['name'], 'the name is the signed-in user' );
} );

test( 'does not answer to GET, and gives no detail when it cannot sign', function () {
	identity_on( array( 'identity_secret' => '' ) );
	wp_set_current_user( make_user()->ID );
	same( 404, rest_do_request( new WP_REST_Request( 'GET', '/hamnivo-chat/v1/identity' ) )->get_status(), 'GET' );
	$failed = rest_do_request( new WP_REST_Request( 'POST', '/hamnivo-chat/v1/identity' ) );
	same( 500, $failed->get_status() );
	same( 'hamnivo_chat_identity', $failed->get_data()['code'] );
	same( 'The chat could not verify you right now.', $failed->get_data()['message'] );
} );

test( 'adds the identity script, with a nonce for signed-in users only', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$out = page_footer();
	contains( 'assets/identity.js?ver=0.2.0', $out );
	contains( 'window.HamnivoChatIdentity = {"loggedIn":false,', $out );
	contains( '"nonce":""', $out );
	contains( '"endpoint":"' . str_replace( '/', '\\/', rest_url( 'hamnivo-chat/v1/identity' ) ) . '"', $out );

	$GLOBALS['wp_scripts'] = null;
	wp_set_current_user( make_user()->ID );
	$out = page_footer();
	contains( '"loggedIn":true', $out );
	preg_match( '/"nonce":"([a-f0-9]+)"/', $out, $match );
	truthy( ! empty( $match[1] ) && wp_verify_nonce( $match[1], 'wp_rest' ), 'a valid REST nonce' );
} );

test( 'adds the identity script only when verified customers are on and the chat is on the page', function () use ( $php81 ) {
	configure();
	lacks( 'identity.js', page_footer(), 'identity off' );
	identity_on( array( 'identity' => '0' ) );
	$GLOBALS['wp_scripts'] = null;
	lacks( 'identity.js', page_footer(), 'switched off' );
	if ( $php81 ) {
		identity_on();
		add_filter( 'hamnivo_chat_should_load', '__return_false' );
		$GLOBALS['wp_scripts'] = null;
		lacks( 'identity.js', page_footer(), 'chat hidden on this page' );
	}
} );

// ---------------------------------------------------------------- Test connection

test( 'passes when the loader is served and the API knows the widget and allows this site', function () {
	$network = fake_network(
		array(
			'chat.example.com/loader.js'     => http_answer( 200, '(()=>{console.error("Hamnivo: add data-widget-id")})()' ),
			'api.example.com/v1/widget/launcher' => http_answer( 200, wp_json_encode( array( 'widgetId' => WIDGET, 'version' => 1 ) ) ),
		)
	);
	$result = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	same( true, $result['ok'], wp_json_encode( $result ) );
	same( 3, count( $result['checks'] ) );
	same( 'https://chat.example.com/loader.js', $network->calls[0]['url'] );
	contains( 'https://api.example.com/v1/widget/launcher?widgetId=' . WIDGET, $network->calls[1]['url'] );
	same( Connection_Test::site_origin(), $network->calls[1]['headers']['Origin'], 'the request carries this site\'s origin' );
	contains( Connection_Test::site_origin(), $result['checks'][2]['detail'] );
} );

test( 'says to add this site to the allowed websites when the API refuses its origin', function () {
	fake_network(
		array(
			'loader.js' => http_answer( 200, 'Hamnivo' ),
			'launcher'  => http_answer( 403, wp_json_encode( array( 'code' => 'ORIGIN_NOT_ALLOWED' ) ) ),
		)
	);
	$result = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	same( false, $result['ok'] );
	same( false, $result['checks'][2]['ok'] );
	contains( 'allowed websites', $result['checks'][2]['detail'] );
	contains( Connection_Test::site_origin(), $result['checks'][2]['detail'] );
} );

test( 'tells an unknown widget ID, a wrong chat address and a broken API apart', function () {
	$run = function ( array $routes ) {
		reset_state();
		fake_network( $routes );
		return Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	};
	$unknown = $run( array( 'loader.js' => http_answer( 200, 'Hamnivo' ), 'launcher' => http_answer( 404, '{"code":"NOT_FOUND"}' ) ) );
	contains( 'does not know this widget ID', $unknown['checks'][2]['detail'] );

	$missing = $run( array( 'loader.js' => http_answer( 404, 'Not found' ), 'launcher' => http_answer( 200, wp_json_encode( array( 'widgetId' => WIDGET ) ) ) ) );
	same( false, $missing['checks'][1]['ok'] );
	contains( 'status 404', $missing['checks'][1]['detail'] );

	$other = $run( array( 'loader.js' => http_answer( 200, '<html>a web page</html>' ), 'launcher' => http_answer( 200, wp_json_encode( array( 'widgetId' => WIDGET ) ) ) ) );
	contains( 'not the Hamnivo loader', $other['checks'][1]['detail'] );

	$broken = $run( array( 'loader.js' => http_answer( 200, 'Hamnivo' ), 'launcher' => http_answer( 500, 'oops' ) ) );
	contains( 'status 500', $broken['checks'][2]['detail'] );

	$wrong_widget = $run( array( 'loader.js' => http_answer( 200, 'Hamnivo' ), 'launcher' => http_answer( 200, wp_json_encode( array( 'widgetId' => 'wid_aaaaaaaaaaaaaaaaaaaaaaaaaa' ) ) ) ) );
	same( false, $wrong_widget['checks'][2]['ok'] );
} );

test( 'says so when an address cannot be reached', function () {
	fake_network( array() );
	$result = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	same( false, $result['checks'][1]['ok'] );
	contains( 'could not', $result['checks'][1]['detail'] );
	contains( 'could not', $result['checks'][2]['detail'] );
} );

test( 'does not call an address on a private network or a name that does not exist, and says why', function () {
	$result = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'http://127.0.0.1:4000', 'api_url' => 'https://nothing-here.invalid' ) );
	same( false, $result['checks'][1]['ok'] );
	contains( 'private network', $result['checks'][1]['detail'] );
	same( false, $result['checks'][2]['ok'] );
	// Where the host name cannot be looked up, WordPress says so. Where this PHP cannot tell, the
	// request fails instead. Either way the person is told that the site could not get there.
	contains( 'could not', $result['checks'][2]['detail'] );
} );

test( 'asks for what is missing, and does not call out when there is nothing to call', function () {
	$network = fake_network( array() );
	$result  = Connection_Test::run( array( 'widget_id' => '', 'chat_url' => '', 'api_url' => '' ) );
	same( false, $result['ok'] );
	same( array(), $network->calls, 'no request was made' );
	contains( 'widget ID', $result['checks'][0]['detail'] );
	contains( 'chat address', $result['checks'][1]['detail'] );
	same( true, $result['checks'][2]['ok'], 'no API address is fine' );
} );

test( 'warns that an http address is blocked on an https site', function () {
	add_filter(
		'home_url',
		function () {
			return 'https://shop.example.com';
		}
	);
	$network = fake_network( array() );
	$result  = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'http://chat.example.com', 'api_url' => 'http://api.example.com' ) );
	contains( 'http://', $result['checks'][1]['detail'] );
	contains( 'https://', $result['checks'][1]['detail'] );
	contains( 'Browsers block', $result['checks'][2]['detail'] );
	same( array(), $network->calls, 'no request was made' );
} );

test( 'checks the identity key too, without sending anything', function () use ( $php81 ) {
	if ( ! $php81 ) {
		skip( 'needs PHP 8.1' );
	}
	identity_on();
	$network = fake_network( array( 'loader.js' => http_answer( 200, 'Hamnivo' ), 'launcher' => http_answer( 200, wp_json_encode( array( 'widgetId' => WIDGET ) ) ) ) );
	$result  = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	same( 4, count( $result['checks'] ) );
	same( true, $result['checks'][3]['ok'] );
	same( 2, count( $network->calls ), 'two requests, none for the key' );

	identity_on( array( 'identity_secret' => 'has a space' ) );
	$result = Connection_Test::run( array( 'widget_id' => WIDGET, 'chat_url' => 'https://chat.example.com', 'api_url' => 'https://api.example.com' ) );
	same( false, $result['checks'][3]['ok'] );
	lacks( 'has a space', $result['checks'][3]['detail'] );
} );

// ---------------------------------------------------------------- the AJAX handler of Test connection

test( 'refuses the Test connection request without its nonce', function () {
	sign_in_as_admin();
	submit( array( 'widget_id' => WIDGET ) );
	$result = run_ajax( array( Admin::class, 'ajax_test' ) );
	same( '-1', $result['died'] );
	same( '', $result['output'] );
} );

test( 'refuses the Test connection request from someone who cannot manage options', function () {
	wp_set_current_user( make_user( array( 'role' => 'subscriber' ) )->ID );
	submit( array( 'nonce' => wp_create_nonce( 'hamnivo_chat_test' ), 'widget_id' => WIDGET ) );
	$network = fake_network( array() );
	$result  = run_ajax( array( Admin::class, 'ajax_test' ) );
	contains( '"success":false', $result['output'] );
	same( array(), $network->calls, 'nothing was requested' );
} );

test( 'answers the Test connection request from an administrator with what is typed in the form', function () {
	sign_in_as_admin();
	submit( array( 'nonce' => wp_create_nonce( 'hamnivo_chat_test' ), 'install_code' => INSTALL ) );
	$network = fake_network(
		array(
			'loader.js' => http_answer( 200, 'Hamnivo' ),
			'launcher'  => http_answer( 200, wp_json_encode( array( 'widgetId' => WIDGET ) ) ),
		)
	);
	$result = run_ajax( array( Admin::class, 'ajax_test' ) );
	$json   = json_decode( $result['output'], true );
	same( true, $json['success'] );
	same( true, $json['data']['ok'] );
	same( 'https://chat.example.com/loader.js', $network->calls[0]['url'], 'tested what was pasted, not what was saved' );
	same( false, get_option( 'hamnivo_chat' ), 'nothing was saved' );
} );

// ---------------------------------------------------------------- the settings page

test( 'shows the settings page to administrators only', function () {
	same( '', capture( array( Admin::class, 'render_page' ) ), 'signed out' );
	wp_set_current_user( make_user( array( 'role' => 'editor' ) )->ID );
	same( '', capture( array( Admin::class, 'render_page' ) ), 'editor' );
} );

test( 'draws the form, with its nonce, its fields, Test connection and the help link', function () {
	sign_in_as_admin();
	configure();
	$page = capture( array( Admin::class, 'render_page' ) );
	contains( "name='option_page' value='hamnivo_chat'", $page, 'the Settings API fields' );
	contains( 'name="_wpnonce"', $page );
	foreach ( array( 'widget_id', 'chat_url', 'api_url', 'install_code', 'identity', 'identity_kid', 'identity_secret', 'trust_emails' ) as $field ) {
		contains( 'name="hamnivo_chat[' . $field . ']"', $page, $field );
	}
	contains( 'id="hamnivo-chat-test"', $page );
	contains( 'Test connection', $page );
	contains( 'How to find these', $page );
	contains( 'href="' . Admin::HELP_URL . '"', $page );
	contains( 'value="' . WIDGET . '"', $page );
	contains( 'The chat is on.', $page );
	truthy( 1 === preg_match( '/<label for="hamnivo_chat_widget_id">/', $page ), 'a label for the widget ID' );
} );

test( 'says the chat is off until it is set up', function () {
	sign_in_as_admin();
	contains( 'The chat is off.', capture( array( Admin::class, 'render_page' ) ) );
} );

test( 'escapes what it prints, and never prints the saved key', function () {
	sign_in_as_admin();
	configure(
		array(
			'widget_id'       => '"><img src=x onerror=alert(1)>',
			'chat_url'        => "https://chat.example.com/'\"><script>alert(2)</script>",
			'identity_kid'    => '"><svg onload=alert(3)>',
			'identity_secret' => 'TOP-SECRET-VALUE-123',
		)
	);
	$page = capture( array( Admin::class, 'render_page' ) );
	lacks( '<img src=x', $page );
	lacks( '<script>alert(2)', $page );
	lacks( '<svg onload', $page );
	contains( '&quot;&gt;&lt;img', $page );
	lacks( 'TOP-SECRET-VALUE-123', $page, 'the key is never shown again' );
	contains( 'A key is saved. Leave this empty to keep it.', $page );
	contains( 'Remove the saved key', $page );
} );

test( 'explains on the page why verified customers are not possible on old PHP', function () use ( $php81 ) {
	sign_in_as_admin();
	$page = capture( array( Admin::class, 'render_page' ) );
	if ( $php81 ) {
		lacks( 'needs PHP 8.1 or newer', $page );
		lacks( 'disabled', $page, 'the identity fields are enabled' );
	} else {
		contains( 'Verified customers need PHP 8.1 or newer', $page );
		contains( PHP_VERSION, $page );
		contains( 'disabled', $page );
	}
} );

test( 'adds a Settings link to the plugin list, and a notice on the plugins page until it is set up', function () {
	Admin::hooks();
	$links = apply_filters( 'plugin_action_links_hamnivo-chat/hamnivo-chat.php', array( '<a href="#">Deactivate</a>' ) );
	contains( 'options-general.php?page=hamnivo-chat', $links[0] );
	contains( 'Settings', $links[0] );
	same( 2, count( $links ) );

	sign_in_as_admin();
	set_current_screen( 'plugins' );
	contains( 'not set up yet', capture( array( Admin::class, 'setup_notice' ) ) );
	configure();
	same( '', capture( array( Admin::class, 'setup_notice' ) ), 'once it is set up' );
	delete_option( 'hamnivo_chat' );
	set_current_screen( 'dashboard' );
	same( '', capture( array( Admin::class, 'setup_notice' ) ), 'never anywhere else' );
} );

test( 'loads the page script and style on its own page only, with a nonce and the texts', function () {
	sign_in_as_admin();
	Admin::enqueue( 'index.php' );
	truthy( ! wp_script_is( 'hamnivo-chat-admin', 'enqueued' ), 'not on another page' );
	Admin::enqueue( 'settings_page_hamnivo-chat' );
	truthy( wp_script_is( 'hamnivo-chat-admin', 'enqueued' ), 'on its page' );
	truthy( wp_style_is( 'hamnivo-chat-admin', 'enqueued' ), 'the style' );
	$before = (string) wp_scripts()->get_data( 'hamnivo-chat-admin', 'before' )[1];
	contains( 'window.hamnivoChatAdmin = {', $before );
	contains( 'hamnivo_chat_test', $before );
	preg_match( '/"nonce":"([a-f0-9]+)"/', $before, $match );
	truthy( ! empty( $match[1] ) && wp_verify_nonce( $match[1], 'hamnivo_chat_test' ), 'a valid nonce' );
} );

// ---------------------------------------------------------------- translations

test( 'passes every text through the plugin text domain, so a translation applies', function () {
	$file = sys_get_temp_dir() . '/hamnivo-chat-de_DE.mo';
	file_put_contents(
		$file,
		make_mo(
			array(
				'Settings'        => 'Einstellungen',
				'Test connection' => 'Verbindung testen',
				'The chat is off. Enter the widget ID and the chat address to turn it on.' => 'Der Chat ist aus.',
			)
		)
	);
	truthy( load_textdomain( 'hamnivo-chat', $file ), 'the translation loads' );
	try {
		Admin::hooks();
		$links = apply_filters( 'plugin_action_links_hamnivo-chat/hamnivo-chat.php', array() );
		contains( 'Einstellungen', $links[0] );
		sign_in_as_admin();
		$page = capture( array( Admin::class, 'render_page' ) );
		contains( 'Verbindung testen', $page );
		contains( 'Der Chat ist aus.', $page );
		contains( 'Widget ID', $page, 'a text without a translation stays English' );
	} finally {
		unload_textdomain( 'hamnivo-chat' );
		unlink( $file );
	}
} );

// The constant cannot be taken back, so this test runs after every test that sets a key.
test( 'prefers an identity key defined in wp-config.php, and says so', function () use ( $php81 ) {
	identity_on( array( 'identity_secret' => 'the-saved-secret' ) );
	same( 'the-saved-secret', Settings::identity_secret(), 'before the constant' );
	same( false, Settings::identity_secret_is_constant() );
	define( 'HAMNIVO_CHAT_IDENTITY_SECRET', ' ' . SECRET . ' ' );
	same( SECRET, Settings::identity_secret(), 'the constant wins, trimmed' );
	same( true, Settings::identity_secret_is_constant() );
	if ( $php81 ) {
		$parts = jwt( Identity::assertion_for( make_user() ) );
		same( hash_hmac( 'sha256', $parts['input'], SECRET, true ), $parts['raw'], 'signed with the constant' );
	}
	sign_in_as_admin();
	$page = capture( array( Admin::class, 'render_page' ) );
	contains( 'HAMNIVO_CHAT_IDENTITY_SECRET in wp-config.php', $page );
	lacks( 'the-saved-secret', $page );
} );

// ---------------------------------------------------------------- uninstall

test( 'removes every setting, and the identity key, when the plugin is deleted', function () {
	configure( array( 'identity' => '1', 'identity_kid' => 'shop-2026', 'identity_secret' => SECRET ) );
	truthy( false !== get_option( 'hamnivo_chat' ), 'saved' );
	global $wpdb;
	truthy( (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'hamnivo%'" ) > 0, 'rows exist' );

	define( 'WP_UNINSTALL_PLUGIN', 'hamnivo-chat/hamnivo-chat.php' );
	require PLUGIN_DIR . '/uninstall.php';

	same( false, get_option( 'hamnivo_chat' ) );
	same( '0', (string) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'hamnivo%'" ), 'no row is left' );
	same( '0', (string) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_value LIKE '%shop-2026%'" ), 'the key is gone from every option' );
} );

finish();
