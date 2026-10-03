# Hamnivo Chat on any website

This puts a chat button on a website you edit by hand, or built with a tool that has a box for custom
code. You paste one line. It takes about two minutes.

If your website is made with WordPress, Shopify, WHMCS or Google Tag Manager, use
[its own guide](README.md) instead: it is easier.

## What you need

- Your **install code** from Hamnivo Studio. [How to get it](README.md#what-every-guide-asks-for).
- A way to change the code of your pages, or the box for custom code in your website builder.
- The address of your website on the brand's **allowed websites** list.
  [How to add it](README.md#allow-your-website).

## 1. Paste the install code

The install code looks like this:

```html
<script src="https://chat.example.com/loader.js" data-widget-id="wid_…" data-api="https://api.example.com" async></script>
```

Paste it into **every page** where you want the chat, on a line of its own just above the closing
`</body>` tag.

If your website has a template or a layout shared by all pages, paste it there once. If you use a
website builder, look in its settings for a box called something like **custom code**, **code
injection** or **footer scripts**, and paste it there. Choose the **end of the page** (the footer),
and **all pages**.

## 2. Allow your website

In Hamnivo Studio, add your website's address to the brand's allowed websites.
[The steps](README.md#allow-your-website).

## 3. Check that the chat shows

Open your website in a private window. The chat button is in the bottom corner. Press it and send a
message: it arrives in your Inbox in Studio. [More on checking](README.md#check-that-it-works).

Open the page from a web address (`https://…`, or `http://localhost:8080` while you test). A page
opened from a file on your computer has no address, and the chat does not open on it.

## If it does not work

| What you see | What to do |
|---|---|
| No chat button | The code is not on the page you opened. View the page's source, and search for `loader.js`. Then clear any cache in front of your website. |
| The button shows, but the chat stays empty | Almost always the allowed websites list. The address must match exactly: `https://example.com` and `https://www.example.com` are two different websites. |
| The button shows twice | The code is on the page twice. Keep one. |
| Your website sends a Content-Security-Policy | It has to allow the chat address in `script-src` and `frame-src`, and the API address in `connect-src`. |

## Signed-in customers

A page cannot vouch for a signed-in customer, because that needs a secret that only a server may
hold. If your website has customers who sign in and you want them to see their own conversations on
any device, ask a developer: [how it works](../../guides/identity.md). There is a runnable
Express example in [`examples/node-express`](../../../examples/node-express).

---

## For developers

The example page is in [`examples/html`](../../../examples/html). The loader is the one script
`loader.js`, about 3.6 KB gzipped. Its settings are `data-*` attributes, and every attribute can
also be given in the query of the script's own address, for platforms that cannot set attributes:
`loader.js?widgetId=wid_…&api=https://api.example.com`. An attribute wins over the address.

| Attribute | Meaning |
|---|---|
| `data-widget-id` | Required. The brand's widget ID. |
| `data-api` | The Hamnivo API. Without it, the loader uses its own defaults. |
| `data-widget-origin` | Where the chat app is served. The origin of `src` by default. |
| `data-locale` | `en`, `ar`, `hi` or `ur`. The page's `lang` by default. |
| `data-mode` | `bubble`, `panel`, `inline` or `fullpage`. Replaces the brand's choice. |
| `data-position` | `bottom-right` or `bottom-left`. |
| `data-color` | The launcher's background. |
| `data-container`, `data-height` | For the `inline` mode: the element to put the chat in, and its height. |
| `data-label`, `data-close-label`, `data-title` | Accessible names. |

From your own code, `window.Hamnivo` has `open()`, `close()`, `toggle()`, `identify(assertion)`,
`reset()` and `on(event, listener)`. All of this is in the
[loader's README](../../../packages/widget-loader/README.md). For a React or Vue app, use
[`@hamnivo/react` or `@hamnivo/vue`](react-vue-next.md), which load the same script for you.
