<?php
/**
 * Plugin Name:       Hamnivo Chat
 * Description:       Adds the Hamnivo chat widget to every page of this site.
 * Version:           0.1.0
 * Requires at least: 5.7
 * Requires PHP:      7.4
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       hamnivo-chat
 */

defined('ABSPATH') || exit;

const HAMNIVO_CHAT_OPTION = 'hamnivo_chat';

/** The saved settings, with every field present. */
function hamnivo_chat_settings(): array
{
  $saved = get_option(HAMNIVO_CHAT_OPTION);
  return wp_parse_args(is_array($saved) ? $saved : [], [
    'widget_id' => '',
    'chat_url' => '',
    'api_url' => '',
  ]);
}

/** Prints the loader on every public page once the widget ID and the chat address are set. */
function hamnivo_chat_print_loader(): void
{
  $settings = hamnivo_chat_settings();
  if ($settings['widget_id'] === '' || $settings['chat_url'] === '') {
    return;
  }
  $attributes = [
    'src' => $settings['chat_url'] . '/loader.js',
    'data-widget-id' => $settings['widget_id'],
    'async' => true,
  ];
  if ($settings['api_url'] !== '') {
    $attributes['data-api'] = $settings['api_url'];
  }
  // Escapes every attribute and applies the wp_script_attributes filter (for example a CSP nonce).
  wp_print_script_tag($attributes);
}
add_action('wp_footer', 'hamnivo_chat_print_loader');

/**
 * Keeps a widget ID of the form wid_… and http(s) addresses without a trailing slash. A value that
 * does not fit keeps the saved one, and the settings page shows why.
 */
function hamnivo_chat_sanitize($input): array
{
  $input = is_array($input) ? $input : [];
  $clean = hamnivo_chat_settings();

  $widget_id = trim(sanitize_text_field($input['widget_id'] ?? ''));
  if ($widget_id === '' || preg_match('/^wid_[0-9a-z]{26}$/', $widget_id)) {
    $clean['widget_id'] = $widget_id;
  } else {
    add_settings_error(
      HAMNIVO_CHAT_OPTION,
      'widget_id',
      __('The widget ID is wid_ followed by 26 lowercase letters and digits.', 'hamnivo-chat')
    );
  }

  foreach (['chat_url', 'api_url'] as $field) {
    $raw = trim((string) ($input[$field] ?? ''));
    $url = untrailingslashit(esc_url_raw($raw, ['https', 'http']));
    if ($raw === '' || $url !== '') {
      $clean[$field] = $url;
    } else {
      add_settings_error(
        HAMNIVO_CHAT_OPTION,
        $field,
        __('Addresses start with https:// (or http:// for local testing).', 'hamnivo-chat')
      );
    }
  }
  return $clean;
}

function hamnivo_chat_register_settings(): void
{
  register_setting('hamnivo_chat', HAMNIVO_CHAT_OPTION, [
    'type' => 'array',
    'sanitize_callback' => 'hamnivo_chat_sanitize',
    'default' => [],
  ]);
  add_settings_section('hamnivo_chat_main', '', '__return_false', 'hamnivo-chat');
  $fields = [
    'widget_id' => [
      __('Widget ID', 'hamnivo-chat'),
      'wid_…',
      __("The brand's widget ID from Hamnivo.", 'hamnivo-chat'),
    ],
    'chat_url' => [
      __('Chat address', 'hamnivo-chat'),
      'https://chat.example.com',
      __('Where Hamnivo Chat and its loader.js are served.', 'hamnivo-chat'),
    ],
    'api_url' => [
      __('API address', 'hamnivo-chat'),
      'https://api.example.com',
      __('The Hamnivo API.', 'hamnivo-chat'),
    ],
  ];
  foreach ($fields as $field => [$label, $placeholder, $help]) {
    add_settings_field(
      'hamnivo_chat_' . $field,
      $label,
      'hamnivo_chat_field',
      'hamnivo-chat',
      'hamnivo_chat_main',
      [
        'label_for' => 'hamnivo_chat_' . $field,
        'field' => $field,
        'placeholder' => $placeholder,
        'help' => $help,
      ]
    );
  }
}
add_action('admin_init', 'hamnivo_chat_register_settings');

function hamnivo_chat_field(array $args): void
{
  $settings = hamnivo_chat_settings();
  printf(
    '<input type="text" class="regular-text code" id="%1$s" name="%2$s[%3$s]" value="%4$s" placeholder="%5$s" /><p class="description">%6$s</p>',
    esc_attr($args['label_for']),
    esc_attr(HAMNIVO_CHAT_OPTION),
    esc_attr($args['field']),
    esc_attr($settings[$args['field']]),
    esc_attr($args['placeholder']),
    esc_html($args['help'])
  );
}

function hamnivo_chat_add_page(): void
{
  add_options_page(
    __('Hamnivo Chat', 'hamnivo-chat'),
    __('Hamnivo Chat', 'hamnivo-chat'),
    'manage_options',
    'hamnivo-chat',
    'hamnivo_chat_render_page'
  );
}
add_action('admin_menu', 'hamnivo_chat_add_page');

function hamnivo_chat_render_page(): void
{
  if (!current_user_can('manage_options')) {
    return;
  }
  ?>
  <div class="wrap">
    <h1><?php echo esc_html(get_admin_page_title()); ?></h1>
    <p>
      <?php esc_html_e("Add this site's address to the brand's allowed websites in Hamnivo. The chat opens only there.", 'hamnivo-chat'); ?>
    </p>
    <form action="options.php" method="post">
      <?php
      settings_fields('hamnivo_chat');
      do_settings_sections('hamnivo-chat');
      submit_button();
      ?>
    </form>
  </div>
  <?php
}

function hamnivo_chat_activate(): void
{
  register_uninstall_hook(__FILE__, 'hamnivo_chat_uninstall');
}
register_activation_hook(__FILE__, 'hamnivo_chat_activate');

/** Removes the saved settings when the plugin is deleted. */
function hamnivo_chat_uninstall(): void
{
  delete_option(HAMNIVO_CHAT_OPTION);
}
