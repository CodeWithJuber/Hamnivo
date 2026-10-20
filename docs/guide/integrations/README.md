# Put the chat on your website

Hamnivo Chat shows a chat button in the corner of your website. Your visitors talk to your team and
to your AI assistant in one conversation. How you add the button depends on what your website is
made with. Find yours in the table, and open the guide.

To connect WHMCS business data, external specialist agents, or MCP services to your agents, use
[Connect business systems and specialist agents](connectors.md).

| Your website is made with | Guide | What you do |
|---|---|---|
| WordPress, with or without WooCommerce | [WordPress](wordpress.md) | Upload a plugin, paste one code |
| Shopify | [Shopify](shopify.md) | Paste one line into your theme |
| WHMCS, the hosting billing system | [WHMCS](whmcs.md) | Upload an addon, switch it on |
| Google Tag Manager | [Google Tag Manager](gtm.md) | Add one tag |
| Anything else with a box for custom code, or pages you edit yourself | [Plain HTML](html.md) | Paste one line |
| A React, Next.js or Vue app | [React, Vue and Next.js](react-vue-next.md) | For developers: add a component |

Every guide ends with a part for developers. You can ignore it.

## What every guide asks for

Hamnivo Studio, the web page where your team works, gives you one piece of code for your website.
It is called the **install code**, and every guide starts from it.

1. Sign in to Hamnivo Studio.
2. Open **Settings**, then **Brands and install**, and choose your brand.
3. Under **Install the chat**, press **Copy install code**.

The code looks like this:

```html
<script src="https://chat.example.com/loader.js" data-widget-id="wid_01j9zk7w3xq8r4t2v6m5n1p0ce" data-api="https://api.example.com" async></script>
```

Some guides ask you to paste the whole code. Others ask for the three values inside it:

| The value | Where it is in the code | What it is |
|---|---|---|
| **Widget ID** | after `data-widget-id=`, it starts with `wid_` | Names your brand. It is not a secret. |
| **Chat address** | the start of `src=`, before `/loader.js` | Where Hamnivo Chat runs. In the example it is `https://chat.example.com`. |
| **API address** | after `data-api=` | The Hamnivo server of the same installation. In the example it is `https://api.example.com`. |

## Allow your website

The chat opens only on websites that your brand allows. Add yours once, in Studio:

1. Open **Settings**, then **Brands and install**.
2. Press **Edit** next to your brand.
3. Under **Allowed websites**, add the address of your website, one per line, for example
   `https://shop.example.com`. Write it exactly as visitors see it: with `https://`, and with `www.`
   if your website uses it. `https://example.com` and `https://www.example.com` are two different
   websites to Hamnivo.
4. Press **Save changes**.

Until you do, the chat button may show, but the chat refuses to open.

## Check that it works

1. Open your website in a private or incognito window, so that nothing old is remembered.
2. Look for the round chat button in the bottom corner, on the right unless you chose the left in
   Studio.
3. Press it, and send a message. It appears in your **Inbox** in Studio.

If there is no button, the guide of your platform has a table of what to check. The causes are
nearly always one of these: the code is not on the page you opened, the website is not on the
allowed list, a page cache still serves the old page, or a security setting blocks the chat's
address.

## Customers who are signed in

A visitor is anonymous by default. If your website has customers who sign in, the chat can show each
of them their own conversations on any device. Your website has to vouch for each customer with a
signature that only your server can make, so this part needs a developer, or whoever runs your
Hamnivo, to register a key once. The guides for WordPress, WHMCS and React, Vue and Next.js have
the steps. [How it works](../../guides/identity.md).
