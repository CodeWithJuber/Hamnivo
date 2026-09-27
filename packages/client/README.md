# @hamnivo/client

Headless chat SDK for the Hamnivo widget API. It runs in browsers and in Node 24 and has no UI.
The widget (`apps/widget`) is built on it. You can build your own chat UI on it too.

| Part | What it does |
|---|---|
| `HamnivoClient` | Opens or resumes the visitor session and keeps the access token fresh. It exposes typed conversation calls. |
| `Outbox` | Sends messages exactly once and shows their real state. Unsent messages survive reloads. |
| `EventStream` | A live conversation stream over Server-Sent Events. It resumes where it stopped. |
| `HamnivoApiError` | RFC 9457 problem details: `status`, `code`, `retryable`, `retryAfterMs`. |

## Use

```ts
import { EventStream, HamnivoClient, Outbox } from '@hamnivo/client';

const client = new HamnivoClient({
  apiBase: 'https://api.example.com',
  widgetId: 'wid_…',
  hostOrigin: location.origin, // must be one of the brand's allowed websites
  locale: 'ur',
});

await client.connect(); // resumes the stored session when there is one
const conversation = await client.startConversation({ firstMessage: 'Assalamu alaikum' });

const outbox = new Outbox(client, conversation.id);
outbox.subscribe((items) => render(items)); // queued → sending → accepted, or failed
outbox.enqueue('Where is my order?');

const stream = new EventStream(client, conversation.id, {
  onEvent: (event) => apply(event), // message.created, conversation.updated, … in order
  onResync: () => reloadHistory(), // the cursor is older than the retained journal
  onStatus: (status) => showConnection(status),
});
```

## Guarantees

- **Sessions.**
  - The refresh token is stored under `hamnivo:{widgetId}:refresh`, in `localStorage` when it is
    available and in memory otherwise.
  - The access token is renewed 60 s before it expires. On a 401 it is renewed once and the request
    is retried.
  - Renewals are single-flight, so concurrent calls never spend a refresh token twice. Spending one
    twice would revoke the session.
- **Sends.**
  - Every message gets a client message id when it is queued. Retries reuse that id, so the server
    stores each message once, even when a response was lost.
  - `accepted` means the conversation authority committed the message, not just that the request
    left the browser.
  - A message is marked `failed` only after 8 attempts or a non-retryable error. `retry(id)` sends
    it again with the same id.
  - Unsent messages are kept under `hamnivo:{widgetId}:outbox:{conversationId}`.
- **Streams.**
  - Streams use `fetch`, so the token travels in a header and never in the URL.
  - They reconnect with backoff and `Last-Event-ID`, and drop events already shown.
  - If nothing arrives within 45 s, not even a heartbeat, the stream reconnects.
  - On `auth_expired` the stream renews the session.
  - On `resync_required` the stream calls `onResync` and starts again from the new head.

## Checks

```bash
pnpm --filter @hamnivo/client test   # msw-backed unit tests: renewal, outbox retries, stream dedupe
```

The browser journey in `apps/widget/e2e` exercises the same code against a real gateway.
