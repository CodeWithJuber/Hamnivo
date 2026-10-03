# Hamnivo Chat for WordPress

The WordPress plugin. A site owner installs it from a zip, pastes the install code from Hamnivo
Studio, and the chat is on the site. Signed-in WordPress users and WooCommerce customers can be
verified, so they see their own conversations on any device.

For site owners there is a step-by-step guide:
[`docs/guide/integrations/wordpress.md`](../../docs/guide/integrations/wordpress.md). This page is
for the people who build, test and release the plugin.

## What is here

| Path | What it is |
|---|---|
| `hamnivo-chat/` | The plugin, as WordPress.org wants it: `hamnivo-chat.php`, `readme.txt`, `uninstall.php`, `includes/`, `assets/`, `languages/`. |
| `tests/` | Tests that run the plugin inside WordPress (WordPress Playground) and through HTTP. |
| `tools/make-pot.php` | Makes `languages/hamnivo-chat.pot`, and checks the rules of a translation-ready plugin. |
| `scripts/test.sh` | Runs every check. |

The plugin has no Composer step. The PHP SDK that signs identities is
[`integrations/php-sdk`](../php-sdk). The build copies it into the zip, under
`lib/hamnivo-php/`. It is not copied into this folder, so there is one copy of it in the
repository. In a copy of this folder without the build, the chat works and customers stay
anonymous, and the settings page says so.

## Build the zip

```bash
pnpm build:integrations                    # all installs
bash scripts/build-integrations.sh wordpress   # only this one
```

It writes `dist/integrations/hamnivo-chat-wordpress.zip`. The build:

- checks that the version is the same in the plugin header, in `HAMNIVO_CHAT_VERSION` and in the
  `Stable tag` of `readme.txt`;
- checks the syntax of every PHP file;
- bundles the SDK, then zips the files in sorted order with one date, so the same sources give
  the same zip, byte for byte;
- checks that the zip holds what it must, and nothing that belongs only in the repository.

## Try it on your computer

```bash
node integrations/wordpress/tests/serve.mjs
```

This builds the plugin and starts a throwaway WordPress with it active, at
`http://127.0.0.1:9400`. Sign in with `admin` and `password`, and open Settings, Hamnivo Chat.
Nothing is installed, and Ctrl+C removes it. It runs WordPress on WebAssembly, so it needs only
Node, and the network the first time, to download WordPress.

## Test it

```bash
integrations/wordpress/scripts/test.sh           # everything, about four minutes
integrations/wordpress/scripts/test.sh --quick   # the files and the browser scripts, in seconds
```

| What | Where | How long |
|---|---|---|
| The plugin's headers, `readme.txt`, escaping and nonce rules, PHP 7.4 syntax, the translation template, and `identity.js` and `admin.js` in jsdom (37 tests) | `examples/wordpress/test` | seconds |
| The plugin inside WordPress, 60 tests, on each PHP version | `tests/plugin.test.mjs`, `tests/php/suite.php` | 25 seconds for each PHP version |
| The plugin through real HTTP: sign-in with cookies, the REST nonce, saving the settings, the AJAX call (12 tests) | `tests/http.test.mjs` | one minute |
| The plugin next to the real WooCommerce (2 tests), when `HAMNIVO_WOOCOMMERCE=1` | `tests/woocommerce.test.mjs` | one minute |

- The default PHP versions are 8.3 and 7.4. Set `HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5` for more.
  The tests were run on all four, with WordPress 7.1.2. On PHP before 8.1 the chat works, and
  the tests check that customers stay anonymous and that the settings page says why.
- The tests build the zip and run on the unpacked zip, so they test what a site owner installs.
- WordPress Playground runs WordPress and PHP on WebAssembly, in Node. Its CLI is licensed
  GPL-2.0-or-later and is large, so it is not a dependency of this repository, which takes only
  MIT, Apache and BSD packages. The tests run it with `pnpm dlx @wp-playground/cli@3.1.56`, and
  pnpm caches it. To use an installed copy, set `HAMNIVO_WP_PLAYGROUND_CLI` to its path.
- The tests keep every request inside the test. The Test connection tests use stand-ins for the
  network, so nothing leaves the machine except the download of WordPress.
- The WordPress coding standards (`WordPress-Extra` and `WordPress-Docs`) find nothing in the
  plugin. Run them with PHP_CodeSniffer, `wp-coding-standards/wpcs` and
  `phpcompatibility/phpcompatibility-wp`. They are not repository dependencies either.

## What the plugin does

1. **Loader.** On every public page it prints the loader script with `wp_print_script_tag`, so
   every attribute is escaped and a security plugin can add a CSP nonce. It stays out of the admin,
   feeds, embeds, the customizer and AJAX calls.
2. **Settings page.** Settings, Hamnivo Chat. It uses the Settings API, so WordPress checks the
   nonce and the `manage_options` capability. Values are cleaned on save: the chat address is
   reduced to its origin, and addresses with spaces or a bad host are refused with a message. A
   pasted install code fills the three values. The key is never printed again.
3. **Test connection.** An AJAX call (nonce and `manage_options` checked) that asks the chat
   address for `loader.js` and the API for `/v1/widget/launcher`, sending this site's origin as
   the browser does. It tells apart a wrong address, an unknown widget ID and a site that is not in
   the brand's allowed websites. It only reads, and WordPress refuses addresses on private
   networks.
4. **Verified customers.** `POST /wp-json/hamnivo-chat/v1/identity` returns a fresh assertion for
   the signed-in user, signed on the server with the bundled SDK. WordPress treats a request
   without its REST nonce as signed out, so another website cannot ask. `assets/identity.js` passes
   the assertion to `Hamnivo.identify()`, resets the chat when the site signs out, and also when a
   later page finds the browser verified but the visitor signed out. A WooCommerce customer is
   verified with the billing name. An email is shared only when the site says it confirms them.
5. **Uninstall.** `uninstall.php` removes the option, on every site of a network.

### Filters

| Filter | Use |
|---|---|
| `hamnivo_chat_should_load` | Turn the chat off on a page, for example `! is_checkout()`. |
| `hamnivo_chat_customer` | Change the customer before it is signed: `id`, `name`, `email`, `emailVerified`. |
| `hamnivo_chat_email_verified` | Say whether a user's email is confirmed. |
| `wp_script_attributes` | WordPress's own filter, for a CSP nonce on the loader tag. |

The constant `HAMNIVO_CHAT_IDENTITY_SECRET` in `wp-config.php` replaces the saved key.

## Release to WordPress.org

The owner needs a WordPress.org account. Nothing here publishes anything.

1. Check the version in three places: the header and `HAMNIVO_CHAT_VERSION` in `hamnivo-chat.php`,
   and `Stable tag` in `readme.txt`. Add the changelog entry and the upgrade notice. The build
   refuses a zip when they differ.
2. Set `Contributors` in `readme.txt` to the WordPress.org user name of the owner. It is a
   placeholder now.
3. Run `php integrations/wordpress/tools/make-pot.php`, then `scripts/test.sh`, then
   `pnpm build:integrations`.
4. Run the Plugin Check plugin on the unpacked zip, on a site of your own. It checks things that
   only WordPress.org knows, and the one gap in these tests is that it could not run on
   WebAssembly (PHP_CodeSniffer needs `php://stdin`).
5. Submit the zip at https://wordpress.org/plugins/developers/add/. After approval, commit the
   unpacked zip to the plugin's SVN `trunk`, and tag it. Add an icon and a banner under
   `assets/` in SVN, and screenshots, if you want them.

The plugin's license is MIT, which WordPress.org accepts. The `External services` section of
`readme.txt` is required by WordPress.org and says where the plugin sends data.
