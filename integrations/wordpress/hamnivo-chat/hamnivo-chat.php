<?php
/**
 * Plugin Name:       Hamnivo Chat
 * Plugin URI:        https://github.com/CodeWithJuber/Hamnivo/tree/main/integrations/wordpress
 * Description:       Adds Hamnivo Chat to your site, and shows signed-in customers their own conversations. Works with WooCommerce.
 * Version:           0.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Hamnivo
 * Author URI:        https://github.com/CodeWithJuber/Hamnivo
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       hamnivo-chat
 * Domain Path:       /languages
 *
 * @package Hamnivo_Chat
 */

defined( 'ABSPATH' ) || exit;

define( 'HAMNIVO_CHAT_VERSION', '0.2.0' );
define( 'HAMNIVO_CHAT_FILE', __FILE__ );
define( 'HAMNIVO_CHAT_DIR', plugin_dir_path( __FILE__ ) );
define( 'HAMNIVO_CHAT_URL', plugin_dir_url( __FILE__ ) );

require_once HAMNIVO_CHAT_DIR . 'includes/class-settings.php';
require_once HAMNIVO_CHAT_DIR . 'includes/class-identity.php';
require_once HAMNIVO_CHAT_DIR . 'includes/class-connection-test.php';
require_once HAMNIVO_CHAT_DIR . 'includes/class-frontend.php';
require_once HAMNIVO_CHAT_DIR . 'includes/class-admin.php';

add_action(
	'plugins_loaded',
	static function () {
		load_plugin_textdomain( 'hamnivo-chat', false, dirname( plugin_basename( HAMNIVO_CHAT_FILE ) ) . '/languages' );
	}
);

\Hamnivo\Chat\Frontend::hooks();
\Hamnivo\Chat\Identity::hooks();
if ( is_admin() ) {
	\Hamnivo\Chat\Admin::hooks();
}
