# Hamnivo Chat (`apps/widget`)

The customer chat that runs in an iframe on a brand's website. It is opened by
`@hamnivo/widget-loader`, runs on `@hamnivo/client`, and renders with assistant-ui's
external-store runtime and the Hamnivo design tokens.

## What it does today

- **Layouts** (W02). The loader places the chat as a floating button, a side panel, inline in
  the page or on the whole page (`mode` in the URL). On screens 480 px wide or 520 px tall and
  under (phones, phones held sideways, a laptop at 200 % zoom), the floating and side-panel chats
  open full screen, and an inline chat is never taller than the screen. Inline and full-page
  chats have no close button.
- **Look** (W03). The header and the greeting under it carry the brand's colour, with its logo
  and name; buttons and the visitor's own messages use the same colour.
  - The chat is light or dark by an explicit choice (`data-theme` on the page), never by the
    visitor's device alone: what the website says (`theme=light|dark` in the frame URL), and
    the device only on the chat's own page (`/c/<widgetId>`). An embedded chat that is told
    nothing stays light.
  - On the dark chat the brand's colour is made lighter until it stands out from the panel
    (3:1); the header keeps the brand's own colour.
  - New messages, menus and the sign that a reply is on its way move a little. Nothing moves
    when the device or the visitor asks for less motion (W14).
  - While the chat starts it shows its own shape, not an empty frame. If it cannot start, it
    says so once and offers "Try again".
- **Home before a conversation** (W17). The greeting and who can answer, in the brand's colour;
  the visitor's last conversation, one press away; the brand's suggested questions (each starts
  the conversation) and a search of its public help articles. A proactive prompt the visitor
  opened shows in the brand's own words (W19).
- **Conversations and messages.**
  - Starts a conversation or resumes the visitor's last one, including history; earlier messages
    load on request (W05). A signed-in customer finds the same conversations on every device
    (W18), listed under "More".
  - Shows each message with its sender's name and role (the AI assistant, a support agent) and
    a picture beside it: the sender's own, the brand's logo for its assistant, or initials.
    Replies one sender writes in a row share one name and picture; screen readers still hear
    the name on every message. A line says where a day starts, and every message has its time.
  - Shows honest send states (W06): waiting for connection, sending, sent, read (when Chatwoot
    reports the team saw it), or not sent with the reason and retry, edit and remove.
  - Unread replies: a line where they start, a count on the launcher while the chat is closed and
    a "New messages" button while reading back; what the visitor saw is reported as read.
  - The visitor can delete their own message within the brand's window, after confirming (W23).
  - Under a reply: copy its text, "Helpful", "Not helpful", and a few more reactions (W22). The
    reaction shows as a small badge on the reply it is for. On devices with a pointer, the
    actions of older replies wait for the pointer or the keyboard.
  - While reading earlier messages, new ones never move the page: a button says how many wait,
    and an arrow goes back to the newest.
  - Shared places and contacts show as cards; anything unknown shows as its text (W24).
- **A reply on its way.** As soon as the visitor has written, three dots show beside the
  assistant's picture; the visitor can keep writing.
  - The sign follows the conversation's live events where the gateway sends them: `activity`
    says what the assistant is doing ("Searching the help articles…", "Checking the answer…"),
    and `message.delta` shows the answer while it is written, as formatted text with a caret,
    marked "Writing…" and never counted as a message. The published message takes its place;
    a withdrawn draft leaves nothing behind.
  - The gateway streams replies (`AI_STREAM_REPLIES`, on by default): whole sentences that pass
    its checks, while a brand's live answer check or message guard shows only the steps. Where
    the gateway sends nothing live (an older gateway, streaming off), the dots show for up to 45
    seconds after the visitor's message, and end when a reply or a person arrives.
  - While a reply is written and the message box is empty, Send becomes Stop: nothing of that
    reply is posted, and its draft goes at once (`POST …/reply/stop`). Words typed meanwhile can
    still be sent.
  - Nothing is read out piece by piece: the published reply is announced once.
- **Rich answers** (W08). Markdown through an allow-list: headings (two levels under the chat's
  own), lists, links, tables that scroll inside their own frame, and code with its language and
  a "Copy" button. `[1]` in an answer links to its first source. Sources show as numbered chips
  that open to an excerpt, a note when the source may have changed, and a link.
  - Questions the customer might ask next (a `suggestions` part the gateway adds after the
    answer, `AI_FOLLOW_UPS`) show as chips under the newest answer; a `choices` card shows its
    options as buttons. Either sends the words as the visitor's own message.
- **Files** (W09). The paperclip attaches pictures or PDFs; so does dropping files on the chat or
  pasting them into the message box. Each file is checked by the gateway (type read from its
  bytes, size and count limits, virus scan) before it can be sent; a refused file says why.
  Pictures show as previews that open larger in the chat, and other files download, both
  fetched with the session. Files of a message that could not be sent stay attached.
- **Connection** (W07, W11).
  - A banner shows when the device is offline, with the last update and "Try again".
  - Messages typed while offline wait ("Queue") and are sent once when the connection returns.
  - What is typed is kept as a draft across reloads, per person and conversation.
- **Settings** (under "More"). Text size and less motion (W14); the device's own text size and
  motion settings apply first. Signed-in customers with a verified address choose transcript and
  reply-waiting emails (W25); others are told why they cannot.
- **Handoff.** "Talk to a person" asks for a human, and the waiting state is shown until someone
  takes over.
- **Who can answer, and a message for later** (W11, H19).
  - Under the greeting, in words with an icon: someone is online, the team is busy, it is away
    until a named time (in the brand's time zone), or nobody is online. Read only from the
    configuration.
  - While nobody can answer (the brand chooses: outside business hours, nobody online, or
    either), home offers "Leave a message". The brand's form is checked before sending, with the
    problems listed at the top and the first one focused. The message becomes a ticket: its
    reference is shown, a link goes to the visitor's email, and the ticket joins their
    conversations with its state ("Open", "Waiting for your reply", "Closed").
- **Before the first conversation** (W26, W27).
  - The brand's pre-chat form, unless signed-in customers may go straight in. The visitor's first
    message waits, starts the question field, and goes with the answers; "Not now" gives it back.
  - Consent, when the brand asks for it: its words, its privacy policy and a box never ticked in
    advance. When the words change, the visitor is asked again.
- **Reopening** (W15). "I still need help" opens a closed conversation again, from the rating or
  the closed banner.
- **Direct chat link** (W28). `/c/<widgetId>` is the chat on its own page, without a website
  around it: the session is opened as direct, the tab shows the brand's name, and search engines
  are asked not to index it.
- **Customer memory** (when the brand's assistant uses it).
  - Asks first: what would be remembered, why, what never is and for how long, with two equal
    answers. Nothing is remembered without a yes.
  - "Memory" shows what is remembered, with its source and how long it is kept. The customer can
    confirm a newer value, correct or delete one, forget everything and turn memory off.
    Deleting shows progress until it is removed everywhere.
  - An answer that used a memory says so under the message, with a link to it.
- **Languages.** English, Arabic, Hindi and Urdu. Arabic and Urdu use right-to-left layout.
  - Each message and the message box read in their own direction by the majority of their
    letters; order numbers, amounts, emails and links are isolated left to right (`<bdi>`), also
    in answers written in Markdown, and copy back unchanged.
  - When a message fits both Hinglish and Roman Urdu, the chat asks once which language replies
    should use (suggestion first, "not now" to close). The choice is saved on the server, and so
    is the interface language, as inputs to the reply language.
- **Typing.** Enter sends and Shift+Enter starts a new line. An Enter that confirms an input
  method composition (Hindi, Urdu, Arabic or Chinese keyboards) never sends. The message box is
  one rounded field with attach, emoji and send; its text is 16 px, so phones do not zoom in.
- **Accessibility.**
  - Everything works from the keyboard.
  - Escape closes what is open on top first (the menu, the emoji, a picture), then the chat.
  - A screen opened from the chat (settings, conversations) takes focus on its name.
  - Labelled controls.
  - New messages are announced politely.
- **Shopping** (`src/commerce/`, when the brand has a merchant connection).
  - "Browse products" shows the shop's products with price, stock as reported, and when they were
    read. The cart bar changes a draft cart only.
  - "Review order" asks the shop for an exact quote. The card shows the seller, lines, delivery,
    tax, total, refund terms, and how long the price holds. Before enabling "Approve", the widget
    recomputes the quote's hash and checks it against the card. The button is disabled once the
    price expires.
  - Payment happens only on the provider's page, which opens in a new tab. When the tab comes
    back (`checkout-return.html`), the card says "confirming" until the provider confirms; it
    never says "paid" on its own. Cancelling keeps the cart. After a bank challenge, the same
    page finishes the payment.
  - Receipt and order status cards come from Hamnivo's records, never from the AI's text. A
    delayed order shows the shop's estimate as an estimate, and offers "Talk to a person".
  - Amounts and times use the chosen language's formatting, always with the currency and the
    time zone.

## Develop

```bash
pnpm --filter @hamnivo/widget dev      # http://localhost:5174/?widgetId=wid_…&api=http://localhost:4000
pnpm --filter @hamnivo/widget build    # static files in dist/
```

The gateway accepts a session only from an origin on the brand's allowed list, and the widget
page itself has no host. To try it alone, pass `host=http://localhost:5174` in the query and add
that origin to the brand's allowed websites. The normal path is through the loader on a host page;
see `docs/self-hosting.md`.

## Browser journey (Playwright + axe)

```bash
pnpm build
pnpm --filter @hamnivo/widget test:e2e
```

- `e2e/stack.ts` starts everything the journey needs:
  - a throwaway database;
  - the fake Chatwoot;
  - the built gateway API and worker;
  - the widget and loader;
  - a host page on another origin.
- It needs `DATABASE_URL`, `DATABASE_OWNER_URL` and `REDIS_URL`. `pnpm ci:local` provides them in
  throwaway containers, and that is the easiest way to run it.
- `e2e/journey.spec.ts` covers:
  - host page → widget → AI reply → staff takeover → human reply;
  - signing customers in and out, across tabs;
  - an offline message sent once after reconnecting;
  - Arabic and Urdu right-to-left layout with an axe audit (WCAG 2.2 AA);
  - refusal on a website the brand did not allow.
- `e2e/composer.spec.ts` covers input method composition (no send on the confirming Enter),
  message direction and isolated identifiers in Urdu with axe, and the Hinglish/Roman Urdu
  language question.
- `pnpm --filter @hamnivo/widget test` checks that every locale has every key and placeholder,
  and the chat's pure rules: Markdown (what is kept, tables, code, source links), how messages
  group, the live run and draft reducers, and the light and dark colours.
- `e2e/shopping.spec.ts` buys through the fake Stripe server (`startFakeStripe`) and its hosted
  page; nothing reaches the real Stripe. It covers: products → cart → exact quote → approval →
  payment page → paid receipt → a delay update; cancelling with the cart kept, and the quote in
  Arabic; a bank challenge finished on the same page with one payment; and the approval button
  disabled at expiry. Each step is checked with axe.
- `e2e/memory.spec.ts` turns customer memory on for the test brand (and off again) and covers the
  memory question, "Memory" with confirm, correct, delete and the switch, an answer that used a
  memory, memory being unavailable, and right-to-left layout, each with an axe audit.
- `e2e/surface.spec.ts` covers the customer surface: files (a program refused by its bytes,
  previews and downloads), drafts, the offline queue, earlier history and the new-messages
  button, a failed send with its reason, read receipts from Chatwoot, unread counts on the
  launcher, deleting and reacting, help suggestions and search, proactive prompts with their
  limits, the four layouts, text size and less motion, keyboard use, 320 px and 200 % zoom in
  English and Arabic, continuing on another device and email choices, with axe audits.


## Layout audit and live check (no database)

```bash
pnpm --filter @hamnivo/widget-loader build && pnpm --filter @hamnivo/widget exec vite build
node apps/widget/e2e/layout-audit.ts <dir>             # every screen size, layout and scenario
CHECK=live node apps/widget/e2e/layout-audit.ts <dir>  # how a reply arrives
CHECK=api node apps/widget/e2e/layout-audit.ts <dir>   # the website's side (Hamnivo.on, prefill…)
CHECK=sites node apps/widget/e2e/layout-audit.ts <dir> # websites of other kinds (below)
```

- The audit opens the built chat against a mocked gateway on 20 screen sizes, in the four
  layouts, with an empty home, a conversation (English and Arabic), a waiting banner and a long
  answer (table, code, sources). It measures sideways overflow, controls off screen, small tap
  targets, the frame leaving the window and a message area under 160 px, and writes a
  screenshot per case and `report.json`.
- `CHECK=live` sends the events a streaming gateway would send and fails on the first thing
  wrong: the dots after sending, the step in words, the draft (formatted, marked, not counted
  as a reply), the published message in its place, the menu and Escape, reading earlier
  messages while a reply arrives, and the long answer on a phone, light and dark.
- `CHECK=sites` puts the chat on websites of other kinds and fails on the first thing wrong:
  rules that style every button, frame and div; a strict Content-Security-Policy with Trusted
  Types (no violation may be reported); a dark page, and the same page turning light; a page
  read right to left; the loader's own options and the larger chat; a single-page app that
  changes its address and replaces its body; a phone, where the launcher steps away under the
  chat and gets focus back; a return visit; and a website the brand did not allow.
- The browser journeys (`test:e2e`) run with reduced motion, so their accessibility audits see
  what stays on screen; the motion is what `CHECK=live` and `CHECK=sites` look at.
