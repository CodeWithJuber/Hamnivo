# Hamnivo Chat on WHMCS

This puts a chat button on every page of your WHMCS client area. Your clients can ask questions
before they buy and while they are signed in. You upload one addon and fill in a few boxes. It
takes about ten minutes, and you need access to the files of your WHMCS.

## What you need

- WHMCS 8 or newer, an administrator account, and a way to upload files to your WHMCS (FTP, SFTP,
  or your host's file manager).
- Your **install code** from Hamnivo Studio, or the three values in it.
  [How to get them](README.md#what-every-guide-asks-for).
- The address of your WHMCS on the brand's **allowed websites** list.
  [How to add it](README.md#allow-your-website).

## 1. Download the addon

Download **`hamnivo-whmcs-addon.zip`**. It comes with each Hamnivo release. If you run your own
Hamnivo, a developer can make it with `pnpm build:integrations`, which writes it to
`dist/integrations/`.

## 2. Upload it

1. Unzip the file on your computer. It holds one folder, `modules/addons/hamnivo`.
2. Upload that folder to your WHMCS, so that this file exists:
   `modules/addons/hamnivo/hamnivo.php`. That is next to the folders of your other addons.

## 3. Switch it on

1. In the WHMCS admin area, open **Configuration**, then **System Settings**, then **Addon
   Modules**.
2. Find **Hamnivo Chat** and press **Activate**. Then press **Configure**.
3. Fill in the boxes:
   - **Widget ID**: starts with `wid_`.
   - **Chat address**: for example `https://chat.example.com`.
   - **API address**: for example `https://api.example.com`.
4. Under **Access Control**, tick the administrator groups that may open the addon page. Tick
   **Full Administrator** if you are not sure.
5. Press **Save Changes**.

Leave the rest of the boxes as they are for now. They are for [signed-in clients](#signed-in-clients-optional).

## 4. Test the connection

1. Open **Addons**, then **Hamnivo Chat**.
2. The page says **The chat is on.** if the widget ID and the chat address are set.
3. Press **Test connection**. It checks the chat address and the API address the way a visitor's
   browser does. It only reads: nothing is created in Hamnivo. Read the lines it shows. **Works**
   is good. **Problem** says what to fix.

## 5. Allow your WHMCS

The page also says **This WHMCS is at** and an address. In Hamnivo Studio, add that address to the
brand's allowed websites. [The steps](README.md#allow-your-website).

## 6. Check that the chat shows

Open your client area in a private window. The chat button is in the bottom corner. Press it and
send a message: it arrives in your Inbox in Studio.
[More on checking](README.md#check-that-it-works).

## If it does not work

| What you see | What to do |
|---|---|
| **Addons** does not list Hamnivo Chat | Under **Configure**, tick your administrator group in **Access Control**, and save. |
| The page says **The chat is off** | The widget ID or the chat address is empty or does not fit. The page lists what to fix. |
| **Test connection** shows a **Problem** | Read the line next to it. It says whether the chat address is wrong, whether the widget ID is unknown, or whether to add this WHMCS to the allowed websites. |
| No chat button, and the page says **The chat is on** | Clear any cache in front of WHMCS. Then, if your client area uses a custom theme, ask your developer to check that its `header.tpl` prints `{$headoutput}`, which is where addons add their code. |
| The button shows but the chat stays empty | Almost always the allowed websites list. Then a security rule (Content-Security-Policy) that blocks the chat's address. It has to allow the chat address in `script-src` and `frame-src`, and the API address in `connect-src`. |

## Signed-in clients (optional)

Without this, every visitor is anonymous. With it, a client who is signed in to WHMCS is known to the
chat by their client ID and name, and their conversations follow them from one device to another.
When they sign out, the chat signs out with them, so the next person on a shared computer starts
fresh.

It needs two things: **PHP 8.1 or newer** on the WHMCS server (the addon page says if yours is
older: the chat still works, and clients stay anonymous), and an **identity key**. Registering the
key is a one-time job for a developer, or whoever runs your Hamnivo:
[the steps](../../guides/identity.md).

1. Open **Configure** again, as in step 3.
2. Tick **Verify signed-in clients**.
3. Type the **Key ID**, and paste the **Key** that Hamnivo showed you once.
4. Tick **Share email addresses** only if WHMCS makes clients confirm their email address, for
   example with a link they click when they sign up. Then your team sees each client's email
   address. Otherwise the chat gets the name only.
5. Press **Save Changes**.

The key is saved in your database, and the addon page never shows it. To keep it out of the
database, add this line to `configuration.php` in your WHMCS folder, and leave the **Key** box
empty. The line wins:

```php
define('HAMNIVO_IDENTITY_SECRET', 'the key that Hamnivo showed you');
```

A staff member who is looking at the client area as a client ("Login as Client") is never made known
to the chat as that client.

What is shared with Hamnivo: the client's ID and name, and the email address only if you ticked the
box above.

### Product names

**Share product names** is off by default. When it is on, the addon also gives the chat the names of
the client's active products, for example "Business Hosting", so that answers can fit them. It is
names only: never a domain, a username, a password, a key or a price. Today's Hamnivo loader does
not read this yet, so turning it on changes nothing until it does. Nothing is lost by waiting.

## Take it off

In **Configuration**, **System Settings**, **Addon Modules**, press **Deactivate** next to Hamnivo
Chat. Its settings are kept, so that switching it on again needs no new setup. To remove it
completely, delete the folder `modules/addons/hamnivo` too.

---

## For developers

The addon is in [`integrations/whmcs/modules/addons/hamnivo`](../../../integrations/whmcs/modules/addons/hamnivo).
Its README has the file layout. It does not touch `modules/servers`.

- **Loader.** The `ClientAreaHeadOutput` hook returns the loader script, with every value escaped.
  It returns nothing until the widget ID and the chat address are set, and a failure in it gives an
  empty answer and never breaks the page.
- **Clients.** The page script asks `index.php?m=hamnivo&a=identity` for a fresh assertion. The
  answer is for the signed-in client only, from the WHMCS session and never from the request: the
  request needs the header `X-Requested-With: XMLHttpRequest`, and a `Sec-Fetch-Site` of the same
  site. It is sent with `Cache-Control: no-store`. The assertion is signed with the bundled
  [PHP SDK](../../../integrations/php-sdk), which matches `@hamnivo/server` byte for byte, and the
  SDK is loaded only when the PHP can run it (8.1 or newer).
- **Reads, never writes.** The addon reads `tbladdonmodules`, `tblconfiguration`, `tblclients`,
  `tblhosting` and `tblproducts`, only the columns it needs. It adds no table and changes no
  template.
- **Build.** `pnpm build:integrations` writes `dist/integrations/hamnivo-whmcs-addon.zip`, with the
  SDK inside and without the tests.
- **Tests.** WHMCS is a commercial product that cannot be installed in the repository's checks, so
  the tests give the addon stand-ins for what WHMCS provides (`add_hook`, `generate_token`, the
  database and the session). 53 PHP tests run on PHP 7.4, 8.1, 8.3 and 8.5:
  `node --test integrations/whmcs/modules/addons/hamnivo/tests/playground.test.mjs`. The checks of
  the files and the browser script run with `pnpm --filter @hamnivo/example-whmcs test`. Try the
  addon on a WHMCS development licence before you roll it out.
