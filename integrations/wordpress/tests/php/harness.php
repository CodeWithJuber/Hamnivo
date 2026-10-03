<?php
/**
 * A very small test harness that runs inside WordPress, in WordPress Playground. It prints TAP
 * (the lines "ok 1 - name" and "not ok 2 - name"), and exits with 1 when a test failed.
 *
 * It is plain PHP 7.4 on purpose: the same suite runs on every PHP version the plugin supports.
 */

error_reporting( E_ALL );
ini_set( 'display_errors', '1' ); // phpcs:ignore WordPress.PHP.IniSet.display_errors_Blacklisted

require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';

/** Where the plugin is mounted. */
const PLUGIN_DIR = '/wordpress/wp-content/plugins/hamnivo-chat';

/** Warnings and notices that come from the plugin's own files fail the test. WordPress's do not. */
set_error_handler(
	static function ( $number, $message, $file, $line ) {
		if ( 0 !== strpos( (string) $file, PLUGIN_DIR ) || ! ( error_reporting() & $number ) ) {
			return false;
		}
		throw new ErrorException( $message, 0, $number, $file, $line );
	}
);

echo '# PHP ' . PHP_VERSION . ', WordPress ' . get_bloginfo( 'version' ) . ', SDK needs 8.1: ' . ( PHP_VERSION_ID >= 80100 ? 'available' : 'not available' ) . "\n";

class Failure extends Exception {
}

$GLOBALS['harness'] = array(
	'count'  => 0,
	'failed' => 0,
);

/**
 * Runs one test. A thrown exception, a failed assertion or a PHP warning from the plugin fails it.
 *
 * @param string   $name What the test checks.
 * @param callable $body The test.
 */
function test( string $name, callable $body ): void {
	$GLOBALS['harness']['count']++;
	$number = $GLOBALS['harness']['count'];
	reset_state();
	try {
		$body();
		echo "ok {$number} - {$name}\n";
	} catch ( Skipped $skip ) {
		echo "ok {$number} - {$name} # SKIP " . $skip->getMessage() . "\n";
	} catch ( Throwable $error ) {
		$GLOBALS['harness']['failed']++;
		echo "not ok {$number} - {$name}\n";
		foreach ( explode( "\n", get_class( $error ) . ': ' . $error->getMessage() ) as $line ) {
			echo "# {$line}\n";
		}
		if ( ! $error instanceof Failure ) {
			echo '# at ' . $error->getFile() . ':' . $error->getLine() . "\n";
		}
	}
	reset_state();
}

class Skipped extends Exception {
}

/**
 * Skips the rest of a test.
 *
 * @param string $why The reason.
 */
function skip( string $why ): void {
	throw new Skipped( $why );
}

/** Ends the run: prints the plan and the count, and sets the exit code. */
function finish(): void {
	$h = $GLOBALS['harness'];
	echo "1..{$h['count']}\n";
	echo "# {$h['count']} tests, {$h['failed']} failed\n";
	exit( $h['failed'] > 0 ? 1 : 0 );
}

/**
 * Puts WordPress back the way a test found it.
 */
function reset_state(): void {
	delete_option( 'hamnivo_chat' );
	wp_set_current_user( 0 );
	foreach ( array( 'hamnivo_chat_should_load', 'hamnivo_chat_customer', 'hamnivo_chat_email_verified', 'wp_script_attributes', 'pre_http_request', 'home_url', 'wp_doing_ajax', 'wp_die_ajax_handler', 'plugin_action_links_hamnivo-chat/hamnivo-chat.php' ) as $hook ) {
		remove_all_filters( $hook );
	}
	unregister_setting( 'hamnivo_chat', 'hamnivo_chat' );
	$GLOBALS['wp_scripts'] = null;
	unset( $GLOBALS['current_screen'] );
	global $wp_query;
	$wp_query = new WP_Query();
	$_POST    = array();
	$_REQUEST = array();
	global $wp_settings_errors;
	$wp_settings_errors = array();
}

/**
 * Sets the data of a POST request, which WordPress reads from $_REQUEST too.
 *
 * @param array<string,string> $data Form values.
 */
function submit( array $data ): void {
	$_POST    = $data;
	$_REQUEST = $data;
}

/**
 * Fails unless two values are equal.
 *
 * @param mixed  $expected What it should be.
 * @param mixed  $actual   What it is.
 * @param string $what     Says what is compared.
 */
function same( $expected, $actual, string $what = '' ): void {
	if ( $expected !== $actual ) {
		throw new Failure( ( '' !== $what ? $what . ': ' : '' ) . 'expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) );
	}
}

/**
 * Fails unless the condition holds.
 *
 * @param mixed  $condition What must be true.
 * @param string $what      Says what is checked.
 */
function truthy( $condition, string $what ): void {
	if ( ! $condition ) {
		throw new Failure( 'expected: ' . $what );
	}
}

/**
 * Fails unless the text contains the part.
 *
 * @param string $needle   The part.
 * @param string $haystack The text.
 * @param string $what     Says what is checked.
 */
function contains( string $needle, string $haystack, string $what = '' ): void {
	if ( false === strpos( $haystack, $needle ) ) {
		throw new Failure( ( '' !== $what ? $what . ': ' : '' ) . 'expected to find ' . var_export( $needle, true ) . ' in ' . var_export( strlen( $haystack ) > 600 ? substr( $haystack, 0, 600 ) . '…' : $haystack, true ) );
	}
}

/**
 * Fails when the text contains the part.
 *
 * @param string $needle   The part.
 * @param string $haystack The text.
 * @param string $what     Says what is checked.
 */
function lacks( string $needle, string $haystack, string $what = '' ): void {
	if ( false !== strpos( $haystack, $needle ) ) {
		throw new Failure( ( '' !== $what ? $what . ': ' : '' ) . 'expected not to find ' . var_export( $needle, true ) . ' in ' . var_export( strlen( $haystack ) > 600 ? substr( $haystack, 0, 600 ) . '…' : $haystack, true ) );
	}
}

/**
 * Runs code and returns what it printed.
 *
 * @param callable $body The code.
 */
function capture( callable $body ): string {
	ob_start();
	try {
		$body();
	} finally {
		$output = (string) ob_get_clean();
	}
	return $output;
}

/**
 * What the footer of a public page prints, after the scripts are enqueued.
 */
function page_footer(): string {
	return capture(
		static function () {
			do_action( 'wp_enqueue_scripts' );
			do_action( 'wp_footer' );
		}
	);
}

/**
 * Saves the settings the way the settings page does.
 *
 * @param array<string,string> $settings Settings to save over the working ones.
 */
function configure( array $settings = array() ): void {
	update_option(
		'hamnivo_chat',
		array_merge(
			array(
				'widget_id' => 'wid_01j9zk7w3xq8r4t2v6m5n1p0ce',
				'chat_url'  => 'https://chat.example.com',
				'api_url'   => 'https://api.example.com',
			),
			$settings
		)
	);
}

/**
 * Makes a user and returns it.
 *
 * @param array<string,mixed> $fields Fields of the user.
 */
function make_user( array $fields = array() ): WP_User {
	static $number = 0;
	$number++;
	$id = wp_insert_user(
		array_merge(
			array(
				'user_login'   => 'customer' . $number,
				'user_pass'    => wp_generate_password(),
				'user_email'   => "customer{$number}@example.com",
				'display_name' => 'Ayesha Khan',
				'role'         => 'subscriber',
			),
			$fields
		)
	);
	if ( is_wp_error( $id ) ) {
		throw new Failure( $id->get_error_message() );
	}
	return new WP_User( $id );
}

/** The decoded parts of an assertion. */
function jwt( string $assertion ): array {
	$parts = explode( '.', $assertion );
	truthy( 3 === count( $parts ), 'an assertion with three parts' );
	return array(
		'header'  => json_decode( b64u( $parts[0] ), true ),
		'payload' => json_decode( b64u( $parts[1] ), true ),
		'input'   => $parts[0] . '.' . $parts[1],
		'raw'     => b64u( $parts[2] ),
	);
}

/** Base64url to bytes. */
function b64u( string $text ): string {
	return (string) base64_decode( strtr( $text, '-_', '+/' ) . str_repeat( '=', ( 4 - strlen( $text ) % 4 ) % 4 ), true );
}

/**
 * A stand-in for the network. The plugin's requests go to it, and never leave this process.
 *
 * @param array<string,array|WP_Error> $routes A part of a URL, and the response to give for it.
 * @return object Its property `calls` lists the requests it saw.
 */
function fake_network( array $routes ): object {
	$state        = new stdClass();
	$state->calls = array();
	add_filter(
		'pre_http_request',
		static function ( $pre, $args, $url ) use ( $state, $routes ) {
			$state->calls[] = array(
				'url'     => $url,
				'headers' => isset( $args['headers'] ) ? $args['headers'] : array(),
			);
			foreach ( $routes as $needle => $response ) {
				if ( false !== strpos( $url, $needle ) ) {
					return $response;
				}
			}
			return new WP_Error( 'http_request_failed', 'The test has no answer for ' . $url );
		},
		10,
		3
	);
	return $state;
}

/**
 * A response as WordPress's HTTP API gives it.
 *
 * @param int    $code The status.
 * @param string $body The body.
 */
function http_answer( int $code, string $body ): array {
	return array(
		'headers'  => array(),
		'body'     => $body,
		'response' => array(
			'code'    => $code,
			'message' => '',
		),
		'cookies'  => array(),
		'filename' => null,
	);
}

/**
 * Runs an AJAX handler the way WordPress does, and returns what it printed, or why it stopped.
 *
 * @param callable $handler The handler.
 * @return array{output:string,died:?string}
 */
function run_ajax( callable $handler ): array {
	add_filter( 'wp_doing_ajax', '__return_true' );
	add_filter(
		'wp_die_ajax_handler',
		static function () {
			return static function ( $message ) {
				throw new Failure( 'died:' . ( is_scalar( $message ) ? (string) $message : '' ) );
			};
		}
	);
	$died   = null;
	$output = capture(
		static function () use ( $handler, &$died ) {
			try {
				$handler();
			} catch ( Failure $stop ) {
				if ( 0 !== strpos( $stop->getMessage(), 'died:' ) ) {
					throw $stop;
				}
				$died = substr( $stop->getMessage(), 5 );
			}
		}
	);
	remove_all_filters( 'wp_doing_ajax' );
	remove_all_filters( 'wp_die_ajax_handler' );
	return array(
		'output' => $output,
		'died'   => $died,
	);
}

/**
 * A translation file in memory format, for testing that texts go through the text domain.
 *
 * @param array<string,string> $pairs Original and translation.
 */
function make_mo( array $pairs ): string {
	$pairs = array_merge( array( '' => "Content-Type: text/plain; charset=UTF-8\n" ), $pairs );
	ksort( $pairs );
	$count   = count( $pairs );
	$ids     = '';
	$strings = '';
	$offsets = array();
	foreach ( $pairs as $id => $string ) {
		$offsets[] = array( strlen( $ids ), strlen( (string) $id ), strlen( $strings ), strlen( $string ) );
		$ids      .= $id . "\0";
		$strings  .= $string . "\0";
	}
	$ids_start     = 28 + 16 * $count;
	$strings_start = $ids_start + strlen( $ids );
	$id_table      = '';
	$string_table  = '';
	foreach ( $offsets as $offset ) {
		$id_table     .= pack( 'VV', $offset[1], $ids_start + $offset[0] );
		$string_table .= pack( 'VV', $offset[3], $strings_start + $offset[2] );
	}
	return pack( 'VVVVVVV', 0x950412de, 0, $count, 28, 28 + 8 * $count, 0, 0 ) . $id_table . $string_table . $ids . $strings;
}
