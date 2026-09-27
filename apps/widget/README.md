# Hamnivo Chat (`apps/widget`)

The customer chat that runs in an iframe on a brand's website. It is opened by
`@hamnivo/widget-loader`, runs on `@hamnivo/client`, and renders with assistant-ui's
external-store runtime and the Hamnivo design tokens.

## What it does today

- **Conversations and messages.**
  - Starts a conversation or resumes the visitor's last one, including history.
  - Shows each message with its sender role: the AI assistant, a support agent, or the visitor.
  - Shows honest send states: queued, sending, sent, or failed with a retry button.
- **Connection.**
  - A banner shows the connection state.
  - A message typed while offline is sent once when the connection returns.
- **Handoff.** "Talk to a person" asks for a human, and the waiting state is shown until someone
  takes over.
- **Languages.** English, Arabic, Hindi and Urdu. Arabic and Urdu use right-to-left layout, and
  message text uses `dir="auto"`.
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
- The four tests cover:
  - host page → widget → AI reply → staff takeover → human reply;
  - an offline message sent once after reconnecting;
  - Arabic and Urdu right-to-left layout with an axe audit (WCAG 2.2 AA);
  - refusal on a website the brand did not allow.
- `e2e/shopping.spec.ts` buys through the fake Stripe server (`startFakeStripe`) and its hosted
  page; nothing reaches the real Stripe. It covers: products → cart → exact quote → approval →
  payment page → paid receipt → a delay update; cancelling with the cart kept, and the quote in
  Arabic; a bank challenge finished on the same page with one payment; and the approval button
  disabled at expiry. Each step is checked with axe.
