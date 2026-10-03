# Hamnivo Chat with Google Tag Manager

If your website already uses Google Tag Manager, you can add the chat there, without touching the
website's code. There are two ways. The first is a **Custom HTML tag**, which works with every
version of Hamnivo and takes two minutes. The second is the **Hamnivo Chat template**, which gives
you a small form instead of a box of code. Choose one.

## What you need

- Edit access to the Tag Manager container of your website, and permission to publish it.
- Your **install code** from Hamnivo Studio, or the three values in it.
  [How to get them](README.md#what-every-guide-asks-for).
- The address of your website on the brand's **allowed websites** list.
  [How to add it](README.md#allow-your-website).

## Way 1: a Custom HTML tag

1. In Tag Manager, open your container, then **Tags**, then **New**.
2. Name it `Hamnivo Chat`.
3. Press **Tag Configuration**, and choose **Custom HTML**.
4. Paste your install code into the **HTML** box. It looks like this:

   ```html
   <script src="https://chat.example.com/loader.js" data-widget-id="wid_…" data-api="https://api.example.com" async></script>
   ```

5. Press **Triggering**, and choose **All Pages**.
6. Press **Save**. Then press **Submit**, and **Publish**.

## Way 2: the Hamnivo Chat template

1. Get **`hamnivo-gtm-template.tpl`**. It comes with each Hamnivo release. If you run your own
   Hamnivo, a developer can make it with `pnpm build:integrations`, which writes it to
   `dist/integrations/`.
2. In Tag Manager, open **Templates**. Under **Tag Templates**, press **New**.
3. Press the three dots at the top right, choose **Import**, and pick the file. Press **Save**.
4. Open **Tags**, then **New**, then **Tag Configuration**. Under **Custom**, choose **Hamnivo
   Chat**.
5. Fill in the form:
   - **Widget ID**: starts with `wid_`.
   - **Chat address**: for example `https://chat.example.com`. It must start with `https://`.
   - **API address (optional)**: for example `https://api.example.com`.
6. Press **Triggering**, and choose **All Pages**.
7. Name the tag `Hamnivo Chat`, and press **Save**. Then press **Submit**, and **Publish**.

The form checks each value as you type, and says what is wrong.

## Check that the chat shows

Before you publish, press **Preview** in Tag Manager and open your website. In the preview, the
**Hamnivo Chat** tag should say **Succeeded**. After you publish, open your website in a private
window: the chat button is in the bottom corner. Press it and send a message: it arrives in your
Inbox in Studio. [More on checking](README.md#check-that-it-works).

## If it does not work

| What you see | What to do |
|---|---|
| The template's tag says **Failed** in the preview | Open your browser's developer console while the preview is on. The tag writes one line that starts with `Hamnivo Chat:` and says which value is wrong. |
| The line says the template **may not load** the address | In Tag Manager, open the template, then **Permissions**, then **Injects scripts**. It has to allow `https://*/loader.js*`, or your own chat address. Import the file again if you changed it. |
| The tag **Succeeded**, but there is no chat button | Your Hamnivo is older than the template and does not read the settings from the address. Use Way 1, the Custom HTML tag, instead. |
| The button shows, but the chat stays empty | Almost always the allowed websites list. Add your website exactly as visitors see it, with `www` if you use it. |
| No tag fires | Check that the trigger is **All Pages**, and that you published the container. |
| You use a cookie banner, and want the chat only after consent | Give the tag a trigger that fires after consent. Or use the consent settings of Tag Manager. |

## Signed-in customers

A tag cannot vouch for a signed-in customer, so on Tag Manager every visitor is anonymous. To show
customers their own conversations, the website has to sign them in to the chat itself:
[how it works](../../guides/identity.md), or use the [WordPress](wordpress.md),
[WHMCS](whmcs.md) or [React, Vue and Next.js](react-vue-next.md) guide.

## Take it off

Pause or delete the tag in Tag Manager, and publish.

---

## For developers

The template is in [`integrations/gtm`](../../../integrations/gtm). Its README explains how to submit
it to the Community Template Gallery, which needs a Google account and a repository of its own.

- **Why the settings are in the address.** A Tag Manager template can load a script with
  `injectScript`, but cannot set `data-*` attributes on it, which is how the install code passes the
  widget ID. So the tag loads
  `https://chat.example.com/loader.js?widgetId=wid_…&api=https%3A%2F%2Fapi.example.com`, and the
  loader reads the same names from its own address when an attribute is missing. An attribute wins
  when both are there, so the install code works as before.
- **What the tag checks.** The widget ID is `wid_` and 26 lower-case letters and digits. The chat
  address is `https://` with a host name, no login and no query. The API address is empty or an
  https address. A setting that holds a variable skips the form's checks, so the code checks again.
  It asks `queryPermission` before it loads anything.
- **The permission.** The template may inject scripts only from `https://*/loader.js*`: any https
  host, because each customer runs Hamnivo on their own address, but only a file called `loader.js`.
  A Tag Manager administrator can narrow it to one host.
- **Tests.** `pnpm --filter @hamnivo/example-gtm test` checks the file, runs the ten scenarios
  written in it and many more settings in a small stand-in for the Tag Manager sandbox, and runs the
  built loader in a browser simulation, given the address the template builds. The stand-in is not
  Tag Manager: after you change the template, import it and run its tests there too.
