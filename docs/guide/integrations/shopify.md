# Hamnivo Chat on Shopify

This puts a chat button on every page of your Shopify store, except the checkout. You paste one line
into your theme. It takes about five minutes. You do not need a developer, and you do not need
anyone's permission but your own.

Shopify does not run a store's own scripts on the checkout pages, so the chat is not there. It is on
the home page, the collection and product pages, the cart and every other page of your store.

## What you need

- A Shopify store, and a staff account that may edit the theme.
- Your **install code** from Hamnivo Studio. [How to get it](README.md#what-every-guide-asks-for).
- The address of your store on the brand's **allowed websites** list. Use both addresses: the one
  your customers see (for example `https://shop.example.com`) and the one that ends in
  `.myshopify.com`, which Shopify also serves. [How to add them](README.md#allow-your-website).

## 1. Make a copy of your theme

A copy lets you undo anything.

1. In your Shopify admin, open **Online Store**, then **Themes**.
2. Next to your live theme, press the three dots **...**, and then **Duplicate**.

## 2. Open the theme's code

1. On the **copy**, press the three dots **...**, and then **Edit code**.
2. Under **Layout**, open the file **theme.liquid**.

## 3. Paste the install code

1. Press **Ctrl+F** (or **Cmd+F** on a Mac) and search for `</body>`. It is near the end of the
   file.
2. Click at the start of that line, and paste your install code just above it, on a line of its
   own. It looks like this:

   ```html
   <script src="https://chat.example.com/loader.js" data-widget-id="wid_…" data-api="https://api.example.com" async></script>
   ```

3. Press **Save**.

## 4. Allow your store

In Hamnivo Studio, add your store's addresses to the brand's allowed websites.
[The steps](README.md#allow-your-website).

## 5. Check the copy, then publish it

1. Back on **Themes**, press **...** next to the copy, then **Preview**.
2. Look for the chat button in the bottom corner. Press it and send a message: it arrives in your
   Inbox in Studio. [More on checking](README.md#check-that-it-works).
3. If it works, press **Publish** on the copy. Your old theme stays in the list as a backup.

If you prefer, you can paste the code into your live theme directly. Then the check is the same, on
your store's address in a private window.

## If it does not work

| What you see | What to do |
|---|---|
| No chat button | Check that the code is in **theme.liquid**, just above `</body>`, and that you pressed **Save**. Then check the theme you are looking at is the one you edited. |
| The button shows, but the chat stays empty | Almost always the allowed websites list. Add both the address your customers see and the `.myshopify.com` one. They must match exactly. |
| No chat on the checkout | That is how Shopify works. The chat is on every other page. |
| The button is on some pages only | A few themes use another layout file for some pages, for example a password page or a landing page. Paste the code into that layout too. |
| You changed your theme and the chat is gone | The code lived in the old theme. Paste it into the new one. The app embed below avoids this. |

## Signed-in customers

On Shopify the chat shows every visitor as anonymous. Showing a customer their own conversations
on any device needs a server that checks who is signed in, and that is not part of this. If you need
it, ask a developer: [how it works](../../guides/identity.md).

## Take it off

Delete the line you pasted from **theme.liquid**, and save.

---

## For developers and agencies: the app embed

Pasting the code puts it in one theme. If you change themes, you paste it again. A **Shopify app
embed** avoids that: it is a small app with one theme app extension. A store owner turns it on with
a switch in the theme editor, under **App embeds**, and types the widget ID and the two addresses
into three boxes. It is in [`integrations/shopify`](../../../integrations/shopify).

It needs an **app in a Shopify Partner account**, so only the owner of your Hamnivo can publish it.
Then:

```bash
npm install -g @shopify/cli@latest
cd integrations/shopify
shopify app config link     # sign in, then create the app "Hamnivo Chat" (or pick yours)
shopify app dev             # preview on a development store
shopify app deploy          # make a version of the app and release it
```

After the app is installed on a store, this address opens the theme editor with the Hamnivo Chat
embed already switched on. Use the store's `.myshopify.com` name and the app's client ID:

```
https://YOUR-STORE.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=CLIENT_ID/hamnivo-chat
```

- **Who can install it.** Shopify decides, and you choose it in your Partner account. For your own
  stores, or one merchant's, use custom distribution, which gives an install link. For every
  merchant, the app has to be listed in the Shopify App Store, and pass Shopify's review. Review
  asks for a listing (icon, description, screenshots), a privacy policy and a support contact, and
  for public apps the three privacy webhooks (customer data request, customer erasure and shop
  erasure), which need an address that Hamnivo answers on. Shopify's rules change, so read its
  current app requirements first. Nothing in this repository submits anything.
- **What the embed does.** It adds one `<script async>` at the end of the page: the same script as the
  install code. It adds nothing until the widget ID and the chat address look right, keeps only the
  origin of the chat address, and escapes every value. The app is extension-only: no server, no
  access to your store's data, and no client ID in the repository.
- **Tests.** The block is rendered with LiquidJS for the values a merchant could type, including
  values that try to break out of the page, and the schema, the folders and Shopify's size limits are
  checked: `pnpm --filter @hamnivo/example-shopify test`. Shopify's own Theme Check (the check
  `shopify app build` runs) found no offenses.
