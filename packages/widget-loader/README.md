# @hamnivo/widget-loader

The one script a website adds to get Hamnivo Chat (W01). It has no dependencies and is about
1.7 KB gzipped (a test fails above 6 KB).

```html
<script
  src="https://chat.example.com/loader.js"
  data-widget-id="wid_…"
  data-api="https://api.example.com"
  async
></script>
```

- It adds an accessible launcher button.
- It creates the chat iframe only when the visitor opens it. Until then, nothing else is
  downloaded, so the page's speed is unaffected.
- Escape closes the chat, from the page or from inside the widget, and focus returns to the
  launcher.

| Attribute | Default | Meaning |
|---|---|---|
| `data-widget-id` | required | The brand's widget id (`wid_…`). |
| `data-api` | the widget's own default | Gateway origin. |
| `data-widget-origin` | origin of `src` | Where the widget app is served. |
| `data-locale` | `<html lang>` | `en`, `ar`, `hi` or `ur`. Arabic and Urdu switch to right to left. |
| `data-position` | `bottom-right` | Or `bottom-left`. |
| `data-color` | `#192A30` (ink) | Launcher background. |
| `data-label`, `data-close-label`, `data-title` | English | Accessible names for the launcher and the iframe. |

## JavaScript API

```js
Hamnivo.open(); Hamnivo.close(); Hamnivo.toggle();
await Hamnivo.identify(assertion); // a short-lived identity assertion signed by your server
await Hamnivo.reset();             // sign the visitor out (for example on logout)
const off = Hamnivo.on('ready', () => {});
Hamnivo.on('identity.changed', ({ verified }) => {}); // after identify (true) or reset (false)
```

`identify` and `reset` reject with `Error('timeout')` when the chat does not answer within 20
seconds. `reset` clears the chat from the screen and ends the session in Hamnivo and in this
browser, including other open tabs; see [`docs/guides/identity.md`](../../docs/guides/identity.md).

Messages between the page and the iframe are accepted only when all three match:

- the widget's origin;
- the iframe's window;
- this loader instance's id.

The widget does the same checks the other way round. The gateway accepts a session only from a
website on the brand's allowed list.

## Build and test

```bash
pnpm --filter @hamnivo/widget-loader build   # dist/loader.js (IIFE)
pnpm --filter @hamnivo/widget-loader test    # builds, then checks the gzipped size
```

Serve `dist/loader.js` next to the widget app (`apps/widget/dist`) from the same origin.
