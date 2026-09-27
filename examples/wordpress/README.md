# Hamnivo Chat for WordPress

`hamnivo-chat.php` is a single-file plugin. It adds the Hamnivo chat loader to every public page
of a WordPress site. You set it up on a settings page.

## Install

1. Copy `hamnivo-chat.php` into `wp-content/plugins/` on your site.
2. In WordPress, open **Plugins** and activate **Hamnivo Chat**.
3. Open **Settings → Hamnivo Chat** and fill in:
   - **Widget ID**: the brand's widget ID (`wid_…`);
   - **Chat address**: where Hamnivo Chat and its `loader.js` are served, for example
     `https://chat.example.com`;
   - **API address**: the Hamnivo API, for example `https://api.example.com`.
4. Add your site's address to the brand's allowed websites in Hamnivo. The chat opens only on
   those websites. See [`../html/README.md`](../html/README.md#allowed-websites).

The plugin prints nothing until the widget ID and the chat address are set. It needs WordPress
5.7 or later and PHP 7.4 or later. Deleting the plugin also deletes its settings.

## What it prints

Before `</body>`, on every public page:

```html
<script src="https://chat.example.com/loader.js" data-widget-id="wid_…"
        data-api="https://api.example.com" async></script>
```

It uses `wp_print_script_tag`, so every attribute is escaped. A security plugin can add a CSP
nonce through the `wp_script_attributes` filter.

## Verified customers

This plugin does not verify signed-in customers. Hamnivo can show verified customers their own
conversation history on any device. To add that, your site signs a short-lived identity assertion
on the server. The steps are in [`docs/guides/identity.md`](../../docs/guides/identity.md).

In PHP you need a JWT library, for example `firebase/php-jwt` through Composer. An HS256 key is
the simplest choice. Hamnivo makes its secret when you register the key.

Sign it only in code that a logged-in user reaches, for example a REST route whose permission
check is `is_user_logged_in()`. The browser must send the REST nonce (`X-WP-Nonce`), or WordPress
treats the request as logged out.

The header:

| Field | Value |
|---|---|
| `alg` | `HS256` (or the algorithm of the key you registered) |
| `kid` | the key id you registered |
| `typ` | `JWT` |

The claims:

| Claim | Value |
|---|---|
| `sub` | the WordPress user ID as a string, for example `"42"`; 1 to 200 characters |
| `aud` | the brand's widget ID (`wid_…`) |
| `iat` | the current time in seconds; a few seconds early is fine, a future time is refused |
| `exp` | `iat` plus 120; at most `iat` plus 300 |
| `jti` | 16 or more random bytes, base64url; a new value every time (8 to 128 characters) |
| `name` | optional; the display name, at most 120 characters |
| `email` | optional; the user's email address |
| `email_verified` | optional; `true` only when your site confirmed the address. Hamnivo keeps the email only then |

For HS256, the HMAC key is the secret's text exactly as Hamnivo showed it. Do not base64-decode
it.

The page then passes the assertion to `Hamnivo.identify(assertion)`. When the user logs out, it
calls `Hamnivo.reset()` first. The Express example shows both:
[`../node-express/public/identity.js`](../node-express/public/identity.js).
