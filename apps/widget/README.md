# Hamnivo Chat (`apps/widget`)

The customer chat that runs in an iframe on a brand's website. It is opened by
`@hamnivo/widget-loader`, runs on `@hamnivo/client`, and renders with assistant-ui's
external-store runtime and the Hamnivo design tokens.

## What it does today

- **Layouts** (W02). The loader places the chat as a floating button, a side panel, inline in
  the page or on the whole page (`mode` in the URL); on narrow screens the first two open full
  screen. Inline and full-page chats have no close button.
- **Home before a conversation** (W17). The brand's greeting, its suggested questions (each starts
  the conversation) and a search of its public help articles. A proactive prompt the visitor
  opened shows in the brand's own words (W19).
- **Conversations and messages.**
  - Starts a conversation or resumes the visitor's last one, including history; earlier messages
    load on request (W05). A signed-in customer finds the same conversations on every device
    (W18), listed under "More".
  - Shows each message with its sender role: the AI assistant, a support agent, or the visitor.
  - Shows honest send states (W06): waiting for connection, sending, sent, read (when Chatwoot
    reports the team saw it), or not sent with the reason and retry, edit and remove.
  - Unread replies: a line where they start, a count on the launcher while the chat is closed and
    a "New messages" button while reading back; what the visitor saw is reported as read.
  - The visitor can delete their own message within the brand's window, after confirming (W23),
    and react to replies with a few emoji (W22).
  - Shared places and contacts show as cards; anything unknown shows as its text (W24).
- **Files** (W09). The paperclip attaches pictures or PDFs. Each file is checked by the gateway
  (type read from its bytes, size and count limits, virus scan) before it can be sent; a refused
  file says why. Pictures show as previews and other files download, both fetched with the
  session.
- **Connection** (W07, W11).
  - A banner shows when the device is offline, with the last update and "Try again".
  - Messages typed while offline wait ("Queue") and are sent once when the connection returns.
  - What is typed is kept as a draft across reloads, per person and conversation.
- **Settings** (under "More"). Text size and less motion (W14); the device's own text size and
  motion settings apply first. Signed-in customers with a verified address choose transcript and
  reply-waiting emails (W25); others are told why they cannot.
- **Handoff.** "Talk to a person" asks for a human, and the waiting state is shown until someone
  takes over.
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
  method composition (Hindi, Urdu, Arabic or Chinese keyboards) never sends.
- **Accessibility.**
  - Everything works from the keyboard.
  - Escape closes the chat.
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
- `pnpm --filter @hamnivo/widget test` checks that every locale has every key and placeholder.
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
