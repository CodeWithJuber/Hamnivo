=== Hamnivo Chat ===
Contributors: hamnivo
Tags: chat, customer support, live chat, woocommerce, ai chat
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.2.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Add Hamnivo Chat to your site in a few minutes. Signed-in customers see their own conversations on any device.

== Description ==

Hamnivo Chat puts a chat button on every public page of your site. Your visitors talk to your team and to your AI assistant in one conversation. This plugin connects your site to Hamnivo. You need a Hamnivo account, either the hosted service or your own installation.

**What you do**

1. Install and activate the plugin.
2. Open Settings, Hamnivo Chat.
3. Paste the install code from Hamnivo Studio, or type the widget ID and the two addresses.
4. Click Test connection, then Save changes.

The chat button appears on your site. There is nothing to edit in your theme.

**Verified customers (optional)**

When a customer is signed in to your site, the chat can show them their own conversations on any device. This works for WordPress users and for WooCommerce customers.

* Your site vouches for each customer with a short-lived signature, made on your own server. The key never leaves your server and never appears in a page.
* The customer comes from your WordPress records, never from the browser.
* When a customer signs out, the chat signs out with them, so the next person on a shared computer starts fresh.
* Email addresses are shared only if you say your site confirms them.

**Good to know**

* The settings page explains each field in plain words, and Test connection tells you what to fix.
* Nothing is loaded from Hamnivo until you set the plugin up.
* The chat loads from the address you enter. It is your own Hamnivo, so no third party sees your visitors.
* Translation-ready. The chat itself follows your site's language.

== Installation ==

1. In WordPress, open Plugins, Add New Plugin, Upload Plugin, and choose the zip file. Or unzip it into `wp-content/plugins/`.
2. Activate Hamnivo Chat.
3. Open Settings, Hamnivo Chat, and fill in the form. The page says where to find each value.
4. In Hamnivo Studio, add the address of your site to the brand's allowed websites. The chat opens only on those websites.

If you used the single-file example plugin from an earlier version, delete it before you activate this one. Your settings carry over.

== Frequently Asked Questions ==

= Where do I find the widget ID and the addresses? =

In Hamnivo Studio, open Settings, then Brands and install. Choose your brand, and under "Install the chat" click "Copy install code". Paste it into the Install code box on the plugin's settings page, and the three values fill in. The settings page also has a short "How to find these" guide.

= The chat does not show. What do I check? =

Click Test connection. It tells you if the chat address is wrong, if the widget ID is unknown, or if your site is not in the brand's allowed websites. Also check that a security plugin or a Content-Security-Policy header allows the chat address in script-src and frame-src, and the API address in connect-src.

= Do I need Composer or any code? =

No. The plugin comes with everything it needs.

= What do verified customers need? =

PHP 8.1 or newer, and an identity key registered in Hamnivo. The plugin works without them: the chat shows, and everyone is an anonymous visitor. On older PHP the settings page says so.

= Is it safe to type the key into the settings? =

The key is saved in your database, like other plugins' API keys, and is never shown again. To keep it out of the database, add `define( 'HAMNIVO_CHAT_IDENTITY_SECRET', '…' );` to wp-config.php. The plugin then uses that.

= Which customers are shared with Hamnivo? =

Only signed-in users, and only their numeric user ID and their name (the billing name for a WooCommerce customer). The email address is shared only if you turn on "This site confirms email addresses". Developers can change this with the `hamnivo_chat_customer` and `hamnivo_chat_email_verified` filters.

= Can I hide the chat on some pages? =

Yes. Add a filter to your theme or a small plugin: `add_filter( 'hamnivo_chat_should_load', function ( $load ) { return $load && ! is_checkout(); } );`

= What happens when I delete the plugin? =

Its settings, including the identity key, are deleted. Nothing else is touched.

== External services ==

This plugin connects your site to Hamnivo Chat, a service you set up yourself. It either runs on your own server or is hosted for you. The two addresses you enter are the only places it talks to.

* **Chat address.** Every visitor's browser loads `loader.js` from here, and the chat opens in a frame from here. The browser sends the usual request data: the visitor's IP address, the browser name and the page address. No data is sent to any other service.
* **API address.** The chat sends the visitor's messages and the widget ID here, and the loader reads the brand's chat settings from it.
* **Verified customers.** When you turn this on, a signed-in customer's browser passes a signed statement to the chat. It holds the WordPress user ID, the name, and the email only if you confirm addresses. It is made on your server and valid for two minutes.
* **Test connection.** In the admin, when you click the button, your server sends two read-only requests, one to each address, from the settings page. Nothing is created.

The terms and the privacy policy that apply are those of the Hamnivo installation you use: your own, or your provider's. Hamnivo's source code and documentation are at https://github.com/CodeWithJuber/Hamnivo.

== Changelog ==

= 0.2.0 =
* A real settings page: widget ID, chat address, API address, Test connection, and help for finding them.
* Paste the install code from Hamnivo Studio to fill in the form.
* Verified customers for WordPress users and WooCommerce customers, with the bundled Hamnivo PHP SDK.
* The chat signs out with your site.
* Translation-ready, with a template in the languages folder.
* Deleting the plugin removes its settings.

= 0.1.0 =
* The first version: one file that prints the loader.

== Upgrade Notice ==

= 0.2.0 =
Adds the settings page, Test connection and verified customers. Delete the single-file example plugin first, if you used it. Your settings carry over.
