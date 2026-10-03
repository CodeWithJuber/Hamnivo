# Hamnivo Chat for WHMCS

Puts Hamnivo Chat on every page of your WHMCS client area. If you turn it on, the chat also knows
which client is signed in, so each client sees their own conversations on any device.

The full guide, with every click, is in
[`docs/guide/integrations/whmcs.md`](../../../../../docs/guide/integrations/whmcs.md).

## Install

1. Unzip `hamnivo-whmcs-addon.zip`. It holds one folder, `modules/addons/hamnivo`.
2. Upload that folder to your WHMCS, so that you have `modules/addons/hamnivo/hamnivo.php` next to
   `modules/addons/` of your other addons.
3. In the WHMCS admin area open **Configuration, System Settings, Addon Modules**, find **Hamnivo
   Chat** and click **Activate**, then **Configure**.
4. Paste the **Widget ID**, the **Chat address** and the **API address**. Hamnivo Studio shows all
   three under Settings, Brands and install. Tick **Full Administrator** for your admin group, and
   save.
5. Open **Addons, Hamnivo Chat** and click **Test connection**.
6. Open your client area. The chat bubble is in the corner.

The chat opens only on websites that the brand allows. Add the address of your WHMCS to the brand's
allowed websites in Hamnivo Studio. The Hamnivo Chat page in the admin area shows the address to add.

## Verified clients (optional)

Without this, every visitor is anonymous. With it, a signed-in client is known to the chat by their
WHMCS client ID, and their conversations follow them from one device to another.

1. Register an identity key for the brand in Hamnivo. This is a one-time job for whoever runs your
   Hamnivo, and the steps are in [`docs/guides/identity.md`](../../../../../docs/guides/identity.md).
   Keep the key ID and the key. Hamnivo shows the key only once.
2. In **Configure**, tick **Verify signed-in clients** and paste the **Key ID** and the **Key**.
3. This needs PHP 8.1 or later on the WHMCS server. On older PHP the chat still works, and clients
   stay anonymous. The Hamnivo Chat page says so.

To keep the key out of the database, add this line to `configuration.php` of your WHMCS and leave the
**Key** field empty. The line wins over the saved field:

```php
define('HAMNIVO_IDENTITY_SECRET', 'the key that Hamnivo showed you');
```

Tick **Share email addresses** only if WHMCS makes clients confirm their email address. Otherwise
the chat gets the name only, because an unconfirmed address could belong to someone else.

## Product names (optional)

**Share product names** lets the answer carry the names of the client's active products, for
example "Business Hosting", as read-only context for the chat. It is names only: never a domain, a
username, a password, a key or a price. It is off by default.

The chat can use this context only when the Hamnivo loader exposes `Hamnivo.setContext()`. The
current loader does not yet, so for now the names are sent to the page and ignored. Nothing is
lost by turning it on early.

## What the addon does and does not do

- It adds the loader to the head of every client area page, through the `ClientAreaHeadOutput` hook.
- It answers `index.php?m=hamnivo&a=identity` with a fresh, short-lived identity assertion for the
  signed-in client, and nothing for anyone else. The client comes from the WHMCS session, never
  from the request. A staff member who is looking at the client area as a client ("Login as
  Client") is not verified as that client.
- It reads: the client's ID, name and, if you allow it, email address, and the names of active
  products. It writes nothing to WHMCS. It adds no table and changes no template.
- It never prints or logs the key, and the admin page never shows it after it is saved.
- It keeps its settings in `tbladdonmodules`, so turning the addon off and on again needs no new
  setup. Removing the addon's folder removes the addon.

## For developers

```
hamnivo.php            the functions WHMCS calls: config, activate, output, clientarea
hooks.php              the ClientAreaHeadOutput hook
lib/                   Settings, Output, Identity, Endpoint, ConnectionTest, Admin, and the Store
                       that reads WHMCS (CapsuleStore). Plain PHP 7.4 syntax.
lib/hamnivo-php/       the PHP SDK that signs identities. The build adds it; it is not in git.
assets/identity.js     the page script: asks the address above, passes the assertion to the chat,
                       and signs the chat out before a log out link is followed
tests/                 a PHP suite with stand-ins for WHMCS, and its runner for several PHP versions
```

Build the zip, from the root of the repository:

```bash
pnpm build:integrations        # writes dist/integrations/hamnivo-whmcs-addon.zip
```

Run the tests:

```bash
php integrations/whmcs/modules/addons/hamnivo/tests/suite.php              # the PHP on this machine
node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs   # PHP 8.3 and 7.4
HAMNIVO_PHP_VERSIONS=7.4,8.1,8.3,8.5 node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs
pnpm --filter @hamnivo/example-whmcs test                                  # file checks, jsdom, and the suite
```

WHMCS is a commercial product, so the tests use stand-ins for `add_hook`, `generate_token`, the
database and the session, and a built zip is not tried inside a real WHMCS. Try it on a WHMCS
development licence before you roll it out to clients.

The addon calls the SDK in `integrations/php-sdk` (`Hamnivo\createIdentityAssertion`), which is
tested against `@hamnivo/server` byte for byte. The SDK needs PHP 8.1, so the addon loads it only
when the PHP can run it.
