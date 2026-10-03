# Hamnivo Chat for WordPress

The WordPress example is now the real plugin, and it lives in
[`integrations/wordpress`](../../integrations/wordpress). It has a settings page, a Test connection
button, verified customers for WordPress users and WooCommerce customers, and a zip that needs no
Composer.

- **Install it on a site:**
  [`docs/guide/integrations/wordpress.md`](../../docs/guide/integrations/wordpress.md).
- **Build the zip:** `pnpm build:integrations`, which writes
  `dist/integrations/hamnivo-chat-wordpress.zip`.
- **Try it on your computer:** `node integrations/wordpress/tests/serve.mjs` starts a throwaway
  WordPress with the plugin active at `http://127.0.0.1:9400` (user `admin`, password `password`).
- **Build and release it:** [`integrations/wordpress/README.md`](../../integrations/wordpress/README.md).

If you used the single-file plugin that was here before, delete it before you install the new one.
Your settings carry over, because both keep them in the same option.

## What this folder holds

The tests of the plugin's files and browser scripts run here, because this is a package of the
repository (the plugin's folder is not):

```bash
pnpm --filter @hamnivo/example-wordpress test
```

They check, in seconds and with no PHP and no network:

- the plugin's headers and `readme.txt`, and that the version is the same everywhere;
- the rules WordPress.org enforces: every echoed value escaped, `$_POST` read once, after the nonce
  and the capability are checked, no debugging or dynamic code, PHP 7.4 syntax only;
- that `uninstall.php` removes the option the settings are saved in;
- that the translation template matches the strings in the code, and every text uses the text
  domain (when PHP is installed);
- `assets/identity.js` in jsdom: it identifies a signed-in customer once the async loader has run,
  asks for a fresh assertion with the REST nonce, ends a verified chat left in the browser when the
  visitor is signed out, and signs the chat out before a log out link is followed, for WordPress
  and for WooCommerce, within three seconds even when the chat never answers;
- `assets/admin.js` in jsdom: the Test connection button sends the form with the nonce, and writes
  what the server says as text, never as HTML.

The tests that run the plugin inside WordPress are in
[`integrations/wordpress/tests`](../../integrations/wordpress/tests).
