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
- `e2e/memory.spec.ts` turns customer memory on for the test brand (and off again) and covers the
  memory question, "Memory" with confirm, correct, delete and the switch, an answer that used a
  memory, memory being unavailable, and right-to-left layout, each with an axe audit.
