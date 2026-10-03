# Hamnivo Chat on WordPress

This puts a chat button on every public page of your WordPress site, with or without WooCommerce.
You upload one plugin and paste one code. You do not edit your theme, and you do not need a
developer. It takes about five minutes.

## What you need

- A WordPress site, version 6.0 or newer, that runs PHP 7.4 or newer, and an administrator account.
- Your **install code** from Hamnivo Studio. [How to get it](README.md#what-every-guide-asks-for).
- The address of your site on the brand's **allowed websites** list. [How to add it](README.md#allow-your-website).

## 1. Download the plugin

Download **`hamnivo-chat-wordpress.zip`**. It comes with each Hamnivo release. If you run your own
Hamnivo, a developer can make it with `pnpm build:integrations`, which writes it to
`dist/integrations/`. Do not unzip it.

If you used the single-file example plugin from an earlier version, delete that plugin first. Your
settings carry over.

## 2. Upload it

1. In WordPress, open **Plugins**, then **Add New Plugin**.
2. Press **Upload Plugin**, then **Choose File**, and pick the zip.
3. Press **Install Now**, and then **Activate Plugin**.

## 3. Paste your install code

1. Open **Settings**, then **Hamnivo Chat**.
2. Paste the install code into the **Install code** box. The **Widget ID**, **Chat address** and
   **API address** below it fill in. You can also type them yourself.
3. Press **Test connection**. Wait for **Everything works.** If it says **Problem**, read the line
   next to it: it says what to fix.
4. Press **Save changes**.

The top of the page now says **The chat is on.**

## 4. Allow your website

In Hamnivo Studio, add the address of your site to the brand's allowed websites.
[The steps](README.md#allow-your-website). The settings page shows the address to add.

## 5. Check that the chat shows

Open your site in a private window. The chat button is in the bottom corner. Press it and send a
message: it arrives in your Inbox in Studio. [More on checking](README.md#check-that-it-works).

## If it does not work

| What you see | What to do |
|---|---|
| No chat button at all | Check the top of the settings page. If it says **The chat is off**, a value is missing or wrong. If it says **The chat is on**, clear your cache: a caching plugin, your host's cache or a CDN may still serve the old page. |
| **Test connection** says **This site could not reach the chat address** | Copy the install code from Studio again and paste it into the **Install code** box. Check it for typing mistakes. |
| It says the chat address starts with `http://` but this site uses `https://` | Use the `https://` address. Browsers block a chat that comes from `http://` on an `https://` page. |
| It says **Hamnivo does not know this widget ID** | The widget ID belongs to another installation, or has a typo. Copy it again, and check that the API address is the one of the same Hamnivo as the chat address. |
| It says your site is **not in the brand's allowed websites** | Add the address shown on the settings page to the brand in Studio. It must match exactly, including `www`. |
| The button shows but the chat stays empty | Almost always the allowed websites list. Then a security plugin, or a rule your host sets, that blocks the chat's address. A rule like that has to allow the chat address in `script-src` and `frame-src`, and the API address in `connect-src`. |
| The button is missing on the checkout or one page | Some themes and page builders leave out the part of the page where the button is added. Ask your developer to check that the theme calls `wp_footer()`. |

## Signed-in customers (optional)

When a customer is signed in to your site, the chat can show them their own conversations on any
device. This works for WordPress users and for WooCommerce customers. The customer comes from your
WordPress records and never from the browser, and when they sign out the chat signs out with them,
so the next person on a shared computer starts fresh.

It needs two things: **PHP 8.1 or newer** on your site (the settings page tells you if yours is
older), and an **identity key**. Registering the key is a one-time job for a developer, or whoever
runs your Hamnivo: [the steps](../../guides/identity.md). Without these two, everything above still
works, and everyone is an anonymous visitor.

1. In **Settings**, **Hamnivo Chat**, under **Verified customers**, tick **Tell the chat who is
   signed in**.
2. Type the **Key ID**, and paste the **Key** that Hamnivo showed you once.
3. Tick **This site confirms email addresses before people can sign in** only if it is true. Then
   your team sees each customer's email address. Otherwise the chat gets the name only.
4. Press **Save changes**.

The key is saved in your database and never shown again. To keep it out of the database, add this
line to `wp-config.php`, and leave the **Key** box empty. The line wins:

```php
define( 'HAMNIVO_CHAT_IDENTITY_SECRET', 'the key that Hamnivo showed you' );
```

What is shared with Hamnivo: for a signed-in user, their user ID and their name (the billing name
for a WooCommerce customer). The email address is shared only if you ticked the box above.

## Take it off

Deactivate and delete the plugin under **Plugins**. Its settings, including the key, are deleted.
Nothing else on your site is touched.

---

## For developers

The plugin is in [`integrations/wordpress`](../../../integrations/wordpress). Its own README has the
file layout and how to release it.

- **Loader.** It prints the loader script in `wp_footer`, on public pages only: not in the admin,
  feeds, embeds, the customizer preview or AJAX calls. Hide it on a page with a filter:

  ```php
  add_filter( 'hamnivo_chat_should_load', function ( $load ) {
      return $load && ! is_checkout();
  } );
  ```

- **Customers.** A small script asks the REST route `hamnivo-chat/v1/identity` for a fresh assertion
  (a cookie and a nonce check, and only for signed-in users), passes it to `Hamnivo.identify()`, and
  calls `Hamnivo.reset()` before a log out link is followed. The assertion is signed on your server
  with the bundled [PHP SDK](../../../integrations/php-sdk), which matches `@hamnivo/server`
  byte for byte. Change what is shared with the filters `hamnivo_chat_customer` and
  `hamnivo_chat_email_verified`.
- **Safe by design.** Every value is escaped where it is printed. The settings page and Test
  connection check a nonce and `manage_options`. Test connection only reads, and refuses addresses
  on a private network. Nothing is loaded from Hamnivo until the plugin is set up.
- **Translations.** Every text is in the `hamnivo-chat` text domain, with a template in
  `languages/hamnivo-chat.pot`.
- **Build.** `pnpm build:integrations` writes `dist/integrations/hamnivo-chat-wordpress.zip`. The
  PHP SDK is bundled, so nobody runs Composer.
- **Tests.** The plugin runs in a real WordPress (WordPress Playground, WordPress and PHP on
  WebAssembly) on PHP 7.4, 8.1, 8.3 and 8.5, through HTTP, and with the real WooCommerce:
  `node --test integrations/wordpress/tests/plugin.test.mjs`. The checks of the files and the
  browser scripts run with `pnpm --filter @hamnivo/example-wordpress test`.
