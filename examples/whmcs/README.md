# Hamnivo Chat for WHMCS

The WHMCS addon lives in [`integrations/whmcs/modules/addons/hamnivo`](../../integrations/whmcs/modules/addons/hamnivo).
It puts the chat on every page of the client area, and can tell the chat which client is signed in.

- **Install it:** [`docs/guide/integrations/whmcs.md`](../../docs/guide/integrations/whmcs.md).
- **Build the zip:** `pnpm build:integrations`, which writes
  `dist/integrations/hamnivo-whmcs-addon.zip`. It has the PHP SDK inside, so nobody runs Composer.
- **Build and test it:** [`integrations/whmcs/modules/addons/hamnivo/README.md`](../../integrations/whmcs/modules/addons/hamnivo/README.md).

WHMCS is a commercial product, so there is no way to start one here. Try the addon on a WHMCS
development licence before you roll it out to your clients.

## What this folder holds

The tests that run as part of the repository's checks, because this is a package of it:

```bash
pnpm --filter @hamnivo/example-whmcs test
```

They check, in seconds and with no network:

- the files WHMCS loads: the functions it calls, the settings form, the `ClientAreaHeadOutput` hook,
  and that a hook failure can never break the client area;
- the rules that keep an addon safe in a billing system: nothing runs when a file is requested
  directly, no debugging or dynamic code, the request is read in two places only, the key is read
  only where it is used, and PHP 7.4 syntax only;
- `assets/identity.js` in jsdom: it identifies a signed-in client once the async loader has run,
  asks for a fresh assertion the way the page itself does, passes on the product names when the
  chat can take them, ends a verified chat left in the browser when the visitor is signed out, and
  signs the chat out before a log out link is followed, within three seconds even when the chat
  never answers;
- the addon's own PHP suite (52 tests), when PHP is installed: settings, loader, identity address,
  product names, Test connection and the admin page, with stand-ins for what WHMCS gives the addon.

The same PHP suite runs on PHP 7.4, 8.1, 8.3 and 8.5 in WordPress Playground, on the built zip:

```bash
HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5 node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs
```
