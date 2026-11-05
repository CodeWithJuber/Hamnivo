# @hamnivo/widget-loader

The one script a website adds to get Hamnivo Chat (W01). It has no dependencies and is about
5.5 KB gzipped (a test fails above 6 KB).

```html
<script
  src="https://chat.example.com/loader.js"
  data-widget-id="wid_…"
  data-api="https://api.example.com"
  async
></script>
```

- It reads the brand's layout, launcher colours and labels from the gateway
  (`GET /v1/widget/launcher`), readable only from the brand's allowed websites. Without
  `data-api`, or when the gateway does not answer within 3 seconds, it uses the attributes below.
- It places the chat in one of four layouts (W02), which the brand chooses in Studio and
  `data-mode` overrides:

  | Mode | What the visitor sees |
  |---|---|
  | `bubble` | A launcher button; the chat opens in a floating window above it. |
  | `panel` | A launcher button; the chat opens as a full-height side panel. |
  | `inline` | The chat inside an element of the page (`data-container`), always open. |
  | `fullpage` | The chat fills the whole page. |

  On screens up to 480 px wide or up to 520 px tall (phones, phones held sideways, a laptop at
  200 % zoom) the bubble and the panel open full screen, sized to the visible area so the
  on-screen keyboard never hides the message box, and the page behind does not scroll. Elsewhere
  the bubble floats above the launcher, up to 400 × 704 px, always inside the window
  (`src/placement.ts`, tested for each size).
- In the launcher modes it creates the chat iframe only when the visitor opens it. Until then,
  only the brand's settings are fetched, so the page's speed is unaffected.
- The launcher shows how many replies wait while the chat is closed, also in its accessible name.
- When a reply arrives while the chat is closed, a small message over the launcher says who
  replied ("New reply from Aisha"), never what they wrote: the conversation stays in the chat's
  frame. While replies wait the tab's title starts with the count, such as `(1) `, and, unless the
  visitor turns it off in the chat's settings, a short sound plays (browsers allow it only after
  the visitor opened the chat once).
- Escape closes the chat, from the page or from inside the widget, and focus returns to the
  launcher.

### Proactive prompts (W19)

A brand can turn on short prompts in Studio (off by default). The loader shows one when the
visitor is on a page, has spent some seconds there, or comes back on another day. It keeps to the
brand's limits on this device: at most `maxPerDay` prompts a day (never more than three), none
for `dismissHours` after a dismissal, one per page view, and never while the chat is open. A
prompt is a small message near the launcher with its own close button; Escape dismisses it.
Opening the chat from a prompt passes only the prompt's id, and the chat shows the brand's own
words.

| Attribute | Default | Meaning |
|---|---|---|
| `data-widget-id` | required | The brand's widget id (`wid_…`). |
| `data-api` | the widget's own default | Gateway origin. |
| `data-widget-origin` | origin of `src` | Where the widget app is served. |
| `data-locale` | `<html lang>` | `en`, `ar`, `hi` or `ur`. Arabic and Urdu switch to right to left. |
| `data-mode` | the brand's layout | `bubble`, `panel`, `inline` or `fullpage`. |
| `data-container` | after the script | CSS selector of the element an `inline` chat goes in. |
| `data-height` | `600px`, at most the screen's height | Height of an `inline` chat. |
| `data-position` | the brand's side | `bottom-right` or `bottom-left`. |
| `data-color` | the brand's accent | Launcher background. |
| `data-label`, `data-close-label`, `data-title` | the brand's labels in `data-locale` | Accessible names for the launcher and the iframe. |
| `data-hidden` | `false` | `true` starts with the launcher hidden until `Hamnivo.show()`. |
| `data-sound` | on | `off`: no sound for new replies on this website. |
| `data-title-alert` | on | `off`: the tab's title is never changed. |

## JavaScript API

```js
Hamnivo.open(); Hamnivo.close(); Hamnivo.toggle();
Hamnivo.hide(); Hamnivo.show();    // the launcher (and the chat) out of sight, and back
Hamnivo.isOpen();                  // true while the chat is open
Hamnivo.getState();                // { open, hidden, unread, mode }
Hamnivo.setLocale('ar');           // en, ar, hi or ur, from now on
Hamnivo.prefill('About order #1042'); // types in the message box and opens the chat
await Hamnivo.identify(assertion); // a short-lived identity assertion signed by your server
await Hamnivo.reset();             // sign the visitor out (for example on logout)
const off = Hamnivo.on('ready', () => {});
```

`prefill` only types: the visitor reads the words and chooses to send them, after the brand's
pre-chat form and consent when it has them. Nothing is sent on the visitor's behalf.

| Event | Payload | When |
|---|---|---|
| `ready` | — | The chat loaded. |
| `open`, `close` | — | The chat opened or closed. |
| `unread` | `count`, `label`, `sound` | Replies waiting while the chat is closed or out of sight. |
| `conversation.started` | `conversationId` | The visitor started a new conversation (not when one they had is opened). |
| `handoff.requested` | `conversationId` | The conversation is waiting for a person. |
| `handoff.accepted` | `conversationId` | A person took the conversation. |
| `message` | `conversationId`, `from` (`ai`, `person` or `system`) | A reply arrived. Its words are never passed to the page. |
| `conversation.resolved` | `conversationId` | The conversation was closed. |
| `identity.changed` | `verified` | After `identify` (true) or `reset` (false). |
| `identity.required` | `actionId` | The visitor must sign in on the website to approve an action. |
| `error` | `code` | The chat could not start. |

If your website sends a Content-Security-Policy, allow the chat's origin in `script-src` and
`frame-src`, and the gateway's origin in `connect-src`.

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
pnpm turbo run test --filter=@hamnivo/widget-loader  # builds first, then checks the gzipped size,
                                                     # the placement for each screen and the prompt rules
```

Serve `dist/loader.js` next to the widget app (`apps/widget/dist`) from the same origin.
