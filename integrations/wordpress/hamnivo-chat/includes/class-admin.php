<?php
/**
 * The settings page, under Settings, Hamnivo Chat.
 *
 * @package Hamnivo_Chat
 */

namespace Hamnivo\Chat;

defined( 'ABSPATH' ) || exit;

/**
 * Where a site owner enters the widget ID and the two addresses, tests them, and turns on verified
 * customers. Only people who can manage options see it, and every request is checked with a nonce.
 */
final class Admin {

	const PAGE         = 'hamnivo-chat';
	const TEST_ACTION  = 'hamnivo_chat_test';
	const HELP_URL     = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guide/integrations/wordpress.md';
	const IDENTITY_URL = 'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guides/identity.md';

	/**
	 * Hooks into the admin.
	 */
	public static function hooks(): void {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'admin_notices', array( __CLASS__, 'setup_notice' ) );
		add_action( 'wp_ajax_' . self::TEST_ACTION, array( __CLASS__, 'ajax_test' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( HAMNIVO_CHAT_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * Adds the page under Settings.
	 */
	public static function add_page(): void {
		add_options_page(
			__( 'Hamnivo Chat', 'hamnivo-chat' ),
			__( 'Hamnivo Chat', 'hamnivo-chat' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Registers the option. WordPress checks the form's nonce and the manage_options capability
	 * before it calls the sanitize callback.
	 */
	public static function register_settings(): void {
		register_setting(
			Settings::GROUP,
			Settings::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( Settings::class, 'sanitize' ),
				'default'           => array(),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * A link to the settings in the list of plugins.
	 *
	 * @param array<int,string> $links The plugin's links.
	 * @return array<int,string>
	 */
	public static function action_links( array $links ): array {
		$settings = sprintf(
			'<a href="%s">%s</a>',
			esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ),
			esc_html__( 'Settings', 'hamnivo-chat' )
		);
		array_unshift( $links, $settings );
		return $links;
	}

	/**
	 * Says on the Plugins page that the plugin still needs its widget ID. Nowhere else, so it never nags.
	 */
	public static function setup_notice(): void {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || 'plugins' !== $screen->id || Settings::is_configured() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		printf(
			'<div class="notice notice-info"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'Hamnivo Chat is installed, but it is not set up yet, so the chat is not on your site.', 'hamnivo-chat' ),
			esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ),
			esc_html__( 'Set it up now', 'hamnivo-chat' )
		);
	}

	/**
	 * Loads the page's script and style, on this page only.
	 *
	 * @param string $hook The admin page being shown.
	 */
	public static function enqueue( string $hook ): void {
		if ( 'settings_page_' . self::PAGE !== $hook ) {
			return;
		}
		wp_enqueue_style( 'hamnivo-chat-admin', HAMNIVO_CHAT_URL . 'assets/admin.css', array(), HAMNIVO_CHAT_VERSION );
		wp_enqueue_script( 'hamnivo-chat-admin', HAMNIVO_CHAT_URL . 'assets/admin.js', array(), HAMNIVO_CHAT_VERSION, true );
		wp_add_inline_script(
			'hamnivo-chat-admin',
			'window.hamnivoChatAdmin = ' . wp_json_encode(
				array(
					'ajaxUrl' => admin_url( 'admin-ajax.php' ),
					'action'  => self::TEST_ACTION,
					'nonce'   => wp_create_nonce( self::TEST_ACTION ),
					'strings' => array(
						'testing' => __( 'Testing…', 'hamnivo-chat' ),
						'allOk'   => __( 'Everything works. Save your changes to keep these settings.', 'hamnivo-chat' ),
						'notOk'   => __( 'Something needs a look. See below.', 'hamnivo-chat' ),
						'failed'  => __( 'The test could not run. Reload this page and try again.', 'hamnivo-chat' ),
						'ok'      => __( 'Works', 'hamnivo-chat' ),
						'problem' => __( 'Problem', 'hamnivo-chat' ),
					),
				),
				JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
			) . ';',
			'before'
		);
	}

	/**
	 * Answers the Test connection button. It tests what is typed in the form, saved or not.
	 */
	public static function ajax_test(): void {
		check_ajax_referer( self::TEST_ACTION, 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'You are not allowed to do this.', 'hamnivo-chat' ) ), 403 );
		}
		// The nonce is checked above. Settings::addresses_from() cleans every value.
		$posted = wp_unslash( $_POST );
		wp_send_json_success( Connection_Test::run( Settings::addresses_from( is_array( $posted ) ? $posted : array() ) ) );
	}

	/**
	 * Draws the page.
	 */
	public static function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = Settings::all();
		$option   = Settings::OPTION;
		?>
		<div class="wrap hamnivo-chat-settings">
			<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
			<?php settings_errors(); ?>

			<?php if ( Settings::is_configured() ) : ?>
				<p class="hamnivo-chat-status hamnivo-chat-status--on"><?php esc_html_e( 'The chat is on. It appears on every public page of this site.', 'hamnivo-chat' ); ?></p>
			<?php else : ?>
				<p class="hamnivo-chat-status hamnivo-chat-status--off"><?php esc_html_e( 'The chat is off. Enter the widget ID and the chat address to turn it on.', 'hamnivo-chat' ); ?></p>
			<?php endif; ?>

			<form action="options.php" method="post">
				<?php settings_fields( Settings::GROUP ); ?>

				<h2><?php esc_html_e( 'Connect your chat', 'hamnivo-chat' ); ?></h2>
				<p>
					<?php esc_html_e( 'You find these in Hamnivo Studio, under Settings, Brands and install. Choose your brand, and under "Install the chat" click "Copy install code".', 'hamnivo-chat' ); ?>
					<a href="<?php echo esc_url( self::HELP_URL ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'How to find these', 'hamnivo-chat' ); ?><span class="screen-reader-text"> <?php esc_html_e( '(opens in a new tab)', 'hamnivo-chat' ); ?></span></a>
				</p>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="hamnivo_chat_install_code"><?php esc_html_e( 'Install code', 'hamnivo-chat' ); ?></label></th>
						<td>
							<textarea id="hamnivo_chat_install_code" name="<?php echo esc_attr( $option ); ?>[install_code]" rows="3" class="large-text code" spellcheck="false" autocomplete="off" aria-describedby="hamnivo_chat_install_code_help" placeholder="&lt;script src=&quot;https://chat.example.com/loader.js&quot; data-widget-id=&quot;wid_…&quot; …&gt;&lt;/script&gt;"></textarea>
							<p class="description" id="hamnivo_chat_install_code_help"><?php esc_html_e( 'Optional. Paste the install code here, and the three values below are read from it when you test or save. You can also type them yourself.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="hamnivo_chat_widget_id"><?php esc_html_e( 'Widget ID', 'hamnivo-chat' ); ?></label></th>
						<td>
							<input type="text" class="regular-text code" id="hamnivo_chat_widget_id" name="<?php echo esc_attr( $option ); ?>[widget_id]" value="<?php echo esc_attr( $settings['widget_id'] ); ?>" placeholder="wid_…" spellcheck="false" autocomplete="off" aria-describedby="hamnivo_chat_widget_id_help" />
							<p class="description" id="hamnivo_chat_widget_id_help"><?php esc_html_e( 'The brand\'s widget ID. It starts with wid_. It is not a secret.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="hamnivo_chat_chat_url"><?php esc_html_e( 'Chat address', 'hamnivo-chat' ); ?></label></th>
						<td>
							<input type="url" class="regular-text code" id="hamnivo_chat_chat_url" name="<?php echo esc_attr( $option ); ?>[chat_url]" value="<?php echo esc_attr( $settings['chat_url'] ); ?>" placeholder="https://chat.example.com" spellcheck="false" autocomplete="off" aria-describedby="hamnivo_chat_chat_url_help" />
							<p class="description" id="hamnivo_chat_chat_url_help"><?php esc_html_e( 'Where Hamnivo Chat runs. Your visitors\' browsers load the chat from here.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="hamnivo_chat_api_url"><?php esc_html_e( 'API address', 'hamnivo-chat' ); ?></label></th>
						<td>
							<input type="url" class="regular-text code" id="hamnivo_chat_api_url" name="<?php echo esc_attr( $option ); ?>[api_url]" value="<?php echo esc_attr( $settings['api_url'] ); ?>" placeholder="https://api.example.com" spellcheck="false" autocomplete="off" aria-describedby="hamnivo_chat_api_url_help" />
							<p class="description" id="hamnivo_chat_api_url_help"><?php esc_html_e( 'The Hamnivo API of the same installation.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
				</table>

				<p>
					<button type="button" class="button" id="hamnivo-chat-test"><?php esc_html_e( 'Test connection', 'hamnivo-chat' ); ?></button>
					<span id="hamnivo-chat-test-status" class="hamnivo-chat-test-status" role="status" aria-live="polite"></span>
				</p>
				<ul id="hamnivo-chat-test-results" class="hamnivo-chat-test-results"></ul>
				<p class="description"><?php esc_html_e( 'The test asks the chat address and the API the way a visitor\'s browser does. It only reads. Nothing is created in Hamnivo.', 'hamnivo-chat' ); ?></p>

				<details class="hamnivo-chat-help">
					<summary><?php esc_html_e( 'How to find these', 'hamnivo-chat' ); ?></summary>
					<ol>
						<li><?php esc_html_e( 'Sign in to Hamnivo Studio, the dashboard where your team answers customers.', 'hamnivo-chat' ); ?></li>
						<li><?php esc_html_e( 'Open Settings, then Brands and install, and choose your brand.', 'hamnivo-chat' ); ?></li>
						<li><?php esc_html_e( 'Under "Install the chat", click "Copy install code". Paste it into the Install code box above.', 'hamnivo-chat' ); ?></li>
						<li><?php esc_html_e( 'Still in Hamnivo Studio, add the address of this website to the brand\'s allowed websites. The chat opens only on those websites.', 'hamnivo-chat' ); ?></li>
						<li>
							<?php
							printf(
								/* translators: %s: this website's address, such as https://shop.example.com */
								esc_html__( 'The address of this website is %s.', 'hamnivo-chat' ),
								'<code>' . esc_html( Connection_Test::site_origin() ) . '</code>'
							);
							?>
						</li>
					</ol>
				</details>

				<h2><?php esc_html_e( 'Verified customers', 'hamnivo-chat' ); ?></h2>
				<p>
					<?php esc_html_e( 'Optional. When a customer is signed in to this site, the chat can show them their own conversations on any device. This works for WordPress users and for WooCommerce customers. This site vouches for each customer with a short-lived signature, made on this server with a key you register in Hamnivo.', 'hamnivo-chat' ); ?>
					<a href="<?php echo esc_url( self::IDENTITY_URL ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'How it works', 'hamnivo-chat' ); ?><span class="screen-reader-text"> <?php esc_html_e( '(opens in a new tab)', 'hamnivo-chat' ); ?></span></a>
				</p>
				<?php
				$reason   = Identity::unavailable_reason();
				$key_hint = '' === $settings['identity_secret'] ? '' : __( 'A key is saved. Leave this empty to keep it.', 'hamnivo-chat' );
				?>
				<?php if ( null !== $reason ) : ?>
					<div class="notice notice-warning inline"><p><?php echo esc_html( $reason ); ?></p></div>
				<?php endif; ?>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Verify signed-in customers', 'hamnivo-chat' ); ?></th>
						<td>
							<label for="hamnivo_chat_identity">
								<input type="checkbox" id="hamnivo_chat_identity" name="<?php echo esc_attr( $option ); ?>[identity]" value="1" <?php checked( '1', $settings['identity'] ); ?> <?php disabled( null !== $reason ); ?> />
								<?php esc_html_e( 'Tell the chat who is signed in', 'hamnivo-chat' ); ?>
							</label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="hamnivo_chat_identity_kid"><?php esc_html_e( 'Key ID', 'hamnivo-chat' ); ?></label></th>
						<td>
							<input type="text" class="regular-text code" id="hamnivo_chat_identity_kid" name="<?php echo esc_attr( $option ); ?>[identity_kid]" value="<?php echo esc_attr( $settings['identity_kid'] ); ?>" spellcheck="false" autocomplete="off" <?php disabled( null !== $reason ); ?> />
							<p class="description"><?php esc_html_e( 'The ID of the identity key you registered in Hamnivo.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="hamnivo_chat_identity_secret"><?php esc_html_e( 'Key', 'hamnivo-chat' ); ?></label></th>
						<td>
							<?php if ( Settings::identity_secret_is_constant() ) : ?>
								<p><?php esc_html_e( 'The key comes from HAMNIVO_CHAT_IDENTITY_SECRET in wp-config.php.', 'hamnivo-chat' ); ?></p>
							<?php else : ?>
								<textarea id="hamnivo_chat_identity_secret" name="<?php echo esc_attr( $option ); ?>[identity_secret]" rows="2" class="large-text code" spellcheck="false" autocomplete="off" aria-describedby="hamnivo_chat_identity_secret_help" placeholder="<?php echo esc_attr( $key_hint ); ?>" <?php disabled( null !== $reason ); ?>></textarea>
								<p class="description" id="hamnivo_chat_identity_secret_help"><?php esc_html_e( 'Paste the secret that Hamnivo showed you once when you registered an HS256 key, exactly as shown. It is never shown here again.', 'hamnivo-chat' ); ?></p>
								<?php if ( '' !== $settings['identity_secret'] ) : ?>
									<p><label for="hamnivo_chat_identity_secret_clear"><input type="checkbox" id="hamnivo_chat_identity_secret_clear" name="<?php echo esc_attr( $option ); ?>[identity_secret_clear]" value="1" /> <?php esc_html_e( 'Remove the saved key', 'hamnivo-chat' ); ?></label></p>
								<?php endif; ?>
							<?php endif; ?>
							<p class="description"><?php esc_html_e( 'To keep the key out of the database, define HAMNIVO_CHAT_IDENTITY_SECRET in wp-config.php instead.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Email addresses', 'hamnivo-chat' ); ?></th>
						<td>
							<label for="hamnivo_chat_trust_emails">
								<input type="checkbox" id="hamnivo_chat_trust_emails" name="<?php echo esc_attr( $option ); ?>[trust_emails]" value="1" <?php checked( '1', $settings['trust_emails'] ); ?> <?php disabled( null !== $reason ); ?> />
								<?php esc_html_e( 'This site confirms email addresses before people can sign in', 'hamnivo-chat' ); ?>
							</label>
							<p class="description"><?php esc_html_e( 'Turn this on only if it is true. Hamnivo then keeps each customer\'s email address, so your team can see it. When it is off, the chat gets the name only.', 'hamnivo-chat' ); ?></p>
						</td>
					</tr>
				</table>

				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
