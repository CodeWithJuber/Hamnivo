# @hamnivo/widget-loader

The one script a website adds to get Hamnivo Chat (W01). It has no dependencies and is about
8.6 KB gzipped (a test fails above 10 KB).

```html
<script
  src="https://chat.example.com/loader.js"
  data-widget-id="wid_…"
  data-api="https://api.example.com"
  async
></script>
```

- It reads the brand's layout, launcher colours and labels from the gateway
  (`GET /v1/widget/launcher`). Without `data-api`, or when the gateway does not answer within 3
  seconds, it uses the attributes below.
- On a website the brand did not allow, or for a widget that does not exist, the gateway refuses
  and the loader shows nothing: no launcher that would open onto an error. The browser's console
  says why ("Hamnivo: Add this website to the brand's allowed websites…").
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
  on-screen keyboard never hides the message box, and the page behind does not scroll (the root
  and the body are both held, which phones need). The launcher is put away while the chat covers
  it, and comes back with focus when the chat closes. Elsewhere the bubble floats above the
  launcher, up to 400 × 704 px, always inside the window; "Make the chat larger" in the chat's
  header grows it to 720 × 920 px, or a side panel to 640 px (`src/placement.ts`, tested for
  each size).
- In the launcher modes it creates the chat iframe only when the visitor opens it. Until then,
  only the brand's settings are fetched, so the page's speed is unaffected. Pointing at or
  focusing the launcher opens the connections the chat will need, so it opens at once.
- A visitor already in a conversation (this device remembers that one exists for 7 days, never
  what it says) gets the chat loaded quietly when the next page is idle, without opening it: the
  unread count, the reply preview and the sound work on every page of the website.
- The launcher shows how many replies wait while the chat is closed, also in its accessible name.
- When a reply arrives while the chat is closed, a small message over the launcher says who
  replied ("New reply from Aisha"), never what they wrote: the conversation stays in the chat's
  frame. While replies wait the tab's title starts with the count, such as `(1) `, and, unless the
  visitor turns it off in the chat's settings, a short sound plays (browsers allow it only after
  the visitor opened the chat once).
- Escape closes the chat, from the page or from inside the widget, and focus returns to the
  launcher. Inside the chat, Escape first closes what is open on top (a menu, the emoji, a
  picture).
- Nothing moves for a visitor whose device asks for less motion. Otherwise the launcher arrives
  with a small scale, lifts under the pointer and turns into a cross while the chat is open; the
  count pops when it grows; prompts slide in; a floating chat rises from its corner, and one
  that fills the screen or the side fades in.
- Printing the page prints the page, not the chat over it.

### Made to work on any website

- **The website's own styles cannot reach the launcher.** The launcher, its count and the prompts
  live in a shadow root under one element (`data-hamnivo-root`), which starts from
  `all: initial` and holds its place with `!important`. The chat frame starts from
  `all: initial` too, and its place, size, border and stacking cannot be overridden. A page
  that styles every `button`, `div`, `svg` and `iframe` (sizes, borders, floats, transforms,
  letter spacing) changes nothing (checked: `CHECK=sites` in `apps/widget/e2e/layout-audit.ts`).
- **A strict Content-Security-Policy and Trusted Types need no exception for it.** Everything is
  styled one property at a time and drawn with DOM calls: no inline style element, no
  `innerHTML`, no `eval`. See [Content-Security-Policy](#content-security-policy).
- **Light or dark, as the website is.** The chat is told whether the page is light or dark: the
  background the page paints first (the body's, then the root's), then the colour scheme it
  declares. The visitor's device alone never turns the chat dark. A page that changes its theme
  takes the chat with it. `data-theme` decides it instead, and so does the brand's choice.
- **Single-page apps.** The address is watched: a new address without a new page is a new page
  view for the prompts and for `data-hide-on`. When a framework replaces `<body>`, the launcher
  and the chat are put back.
- **Tag managers.** Where `document.currentScript` is missing, the script is found by its widget
  ID. A second copy of the loader on the same page does nothing and says so in the console.
- **Phones.** The screen's own bottom edge (a home bar) is measured on the page and passed to the
  chat, which cannot measure it from inside its frame. The message box text is 16 px, so iPhones
  do not zoom in.

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
| `data-theme` | the brand's choice, then the page's | `light`, `dark` or `auto` (follow the page). |
| `data-offset-x`, `data-offset-y` | the brand's place, else `20` | The launcher's distance from the side and from the bottom, in pixels (0 to 400). The chat follows it. |
| `data-size` | the brand's size, else `medium` | Launcher size: `small` (48 px), `medium` (56 px) or `large` (64 px). |
| `data-icon` | the brand's picture, else `chat` | Launcher picture: `chat`, `message`, `help` or `sparkle`. |
| `data-z-index` | `2147483000` | Stacking order of the launcher and the chat, for pages with overlays of their own. |
| `data-hide-on` | none | Pages the chat is kept off: paths separated by commas, each exact or with `*` (`/checkout*, /account/*`). |
| `data-hide-on-mobile` | the brand's choice | `true`: no launcher on screens up to 480 px wide. |
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
Hamnivo.off('ready', listener);    // the same as calling what `on` returned
Hamnivo.destroy();                 // take the chat off the page for good (launcher, frame, listeners)
```

`open`, `toggle`, `show`, `hide` and `prefill` called before the launcher is placed wait for it,
so a website may call them right after adding the script.

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

## Content-Security-Policy

If your website sends a Content-Security-Policy, it needs:

| Directive | Allow | Why |
|---|---|---|
| `script-src` | the chat's origin | `loader.js` itself. |
| `frame-src` | the chat's origin | The chat runs in a frame from there. |
| `connect-src` | the gateway's origin | The brand's launcher settings, and page views where the brand turned them on. |
| `style-src`, `font-src` | the chat's origin | Only for a launcher in the brand's own font (DM Sans or Noto Sans); without them it uses the system font. |

Nothing else: no `'unsafe-inline'`, and `require-trusted-types-for 'script'` with
`trusted-types 'none'` works (checked in a browser with exactly these rules).

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
                                                     # the placement for each screen, the prompt
                                                     # rules, the page's theme and data-hide-on
CHECK=sites node apps/widget/e2e/layout-audit.ts <dir>  # in a browser, on websites of other kinds
```

Serve `dist/loader.js` next to the widget app (`apps/widget/dist`) from the same origin.
