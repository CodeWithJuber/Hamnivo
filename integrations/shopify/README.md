# Hamnivo Chat for Shopify

Puts Hamnivo Chat on every page of a Shopify online store.

There are two ways to get it, and the first needs no account of ours or Shopify's to set up:

1. **Paste the install code into the theme.** Two minutes, on every Shopify plan, with no app. The
   steps for a store owner are in
   [`docs/guide/integrations/shopify.md`](../../docs/guide/integrations/shopify.md).
2. **The app embed**, which is this folder. It is a Shopify app with one theme app extension. A
   store owner turns it on with a switch in the theme editor and types three values into boxes. It
   survives a change of theme, because it is not part of the theme's code. It needs an app in a
   Shopify Partner account, so only the owner of Hamnivo can publish it.

## What is here

```
shopify.app.toml                         an extension-only app: no server, no access to the store
extensions/hamnivo-chat/
  shopify.extension.toml                 type = "theme"
  blocks/hamnivo-chat.liquid             the app embed block: the settings and the loader script
  locales/en.default.schema.json         the words in the theme editor: labels and help texts
```

The block puts one `<script async src="…/loader.js" data-widget-id="…" data-api="…">` at the end of
the body. It is the same script as the install code of Hamnivo Studio. The merchant's three
settings are the widget ID, the chat address and the API address (optional). The block adds
nothing until the widget ID and the chat address look right, escapes every value, keeps only the
origin of the chat address, and never loads anything from a place the merchant did not type.

## Publish it (for whoever owns the Shopify Partner account)

You need a free Shopify Partner account (partners.shopify.com), and a development store to try the
app on. Nobody but you can do these steps, because the app belongs to your account.

```bash
npm install -g @shopify/cli@latest
cd integrations/shopify
shopify app config link     # sign in, then create the app "Hamnivo Chat" (or pick yours)
shopify app dev             # preview on your development store
shopify app deploy          # make a version of the app and release it
```

- `shopify app config link` writes the app's client ID into `shopify.app.toml`. Commit that file.
  The CLI may also rewrite other lines of it. That is fine.
- The first `shopify app deploy` adds a `uid` line to `shopify.extension.toml`. Commit that too.
- `shopify app build` runs Shopify's Theme Check on the extension, as `deploy` does. We ran the same
  check with `@shopify/theme-check-node` 3.30.1 and the `theme-check:theme-app-extension` rules: no
  offenses. It is not one of this repository's tests, because it downloads Shopify's Liquid
  reference at run time.

### Turn it on in a store

After the app is installed on a store, open this address, with your store's `.myshopify.com`
name and your app's client ID. It opens the theme editor with the Hamnivo Chat embed already
switched on:

```
https://YOUR-STORE.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=CLIENT_ID/hamnivo-chat
```

The merchant then types the widget ID, the chat address and the API address, and clicks Save.
`hamnivo-chat` is the name of the block's file, which is why that name must not change.

### Share it or list it

Shopify decides who can install an app, and you choose that in your Partner account:

- **Your own stores, or one merchant's:** use custom distribution, which gives you an install link.
- **Any merchant, through the Shopify App Store:** the app has to pass Shopify's review. Review asks
  for more than the extension: a listing (icon, description, screenshots), a privacy policy and a
  support contact, and for public apps the three privacy webhooks (customer data request, customer
  erasure and shop erasure), which need an address that Hamnivo answers on. Shopify's rules change,
  so read its current app requirements before you start. Nothing in this folder submits anything.

## What it does not do

- **Verified customers.** Visitors are anonymous. To tell the chat which customer is signed in, a
  server has to vouch for them (see [`docs/guides/identity.md`](../../docs/guides/identity.md)). On
  Shopify that means an app proxy and a small server that checks Shopify's signature, which is not
  built here.
- **Checkout.** Shopify does not run a store's own scripts on the checkout pages, so the chat is
  not there. It is on the cart and every other page of the store.

## Tests

```bash
pnpm --filter @hamnivo/example-shopify test
```

They render the block with LiquidJS for the values a merchant could type, in a real HTML parser:
the happy path, trailing slashes, a port, spaces from a paste, every value that must be refused,
and values that try to close the attribute or add an element. They check the schema, the locale
file, the folder layout and the limits Shopify enforces at deploy time.
