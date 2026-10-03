<?php
/**
 * Runs when the plugin is deleted from the Plugins page. It removes everything the plugin saved:
 * its settings, including the identity key. It does not touch anything else.
 *
 * @package Hamnivo_Chat
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

// The same name as Hamnivo\Chat\Settings::OPTION. The plugin's classes are not loaded here.
$hamnivo_chat_option = 'hamnivo_chat';

if ( is_multisite() ) {
	// The plugin can be active on any site of a network, so clean each one.
	$hamnivo_chat_sites = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $hamnivo_chat_sites as $hamnivo_chat_site_id ) {
		switch_to_blog( (int) $hamnivo_chat_site_id );
		delete_option( $hamnivo_chat_option );
		restore_current_blog();
	}
	delete_site_option( $hamnivo_chat_option );
} else {
	delete_option( $hamnivo_chat_option );
}
