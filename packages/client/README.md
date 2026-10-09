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

### Files, drafts and the rest of the chat

```ts
// Files (W09): the gateway reads the type from the bytes and scans the file before keeping it.
const file = await client.uploadAttachment(conversation.id, blob, 'receipt.pdf');
outbox.enqueue('Here is my receipt', [file]); // words and files travel as one message
const bytes = await client.downloadAttachment(conversation.id, part.uploadId); // a Blob

client.drafts.set(`${principalId}:${conversation.id}`, text); // kept across reloads (W07)
await client.markRead(conversation.id, latestSequence); // unread counts, read receipts (W05, W06)
await client.deleteMessage(conversation.id, messageId); // within the brand's window (W23)
await client.react(conversation.id, replyId, crypto.randomUUID(), '👍'); // W22
await client.helpSearch('returns'); // the brand's public help (W17)
await client.setNotifications({ transcript: true }); // verified customers only (W25)
```

A refused file is a `HamnivoApiError` with `code: 'UPLOAD_REJECTED'` (or `UPLOAD_TOO_LARGE`), and
`problem.reason` says why: `type_not_allowed`, `too_large`, `too_many`, `malware_detected` or
`scan_unavailable`.

### Forms, consent and tickets

```ts
// Consent before chatting (W27): the session then says it was given, and listeners hear of it.
await client.giveConsent(session.config.consent.noticeVersion);
// The pre-chat form's answers go with the start (W26); a list answer is the option's id.
await client.startConversation({ prechat: { name: 'Amina', team: 'billing' }, firstMessage });
// A message while nobody can answer (W11) becomes a ticket (H19). The request id is the
// idempotency key: a retry with the same id and answers creates nothing twice.
const { reference, email, confirmationSent } = await client.sendOfflineMessage(
  { answers: { email: 'amina@example.com', question: 'Can I change my order?' } },
  crypto.randomUUID(),
);
await client.reopen(conversation.id); // a closed conversation, with its history (W15)
await client.feedback(conversation.id, { rating: 5, comment: 'Quick and kind' });
```

A chat opened from the brand's direct chat link (W28) passes `direct: true` instead of a
`hostOrigin`. Starting a chat before agreeing, where the brand asks, is refused with
`code: 'CONSENT_REQUIRED'`; answers the form does not accept are `VALIDATION_FAILED`, with
`problem.fields` naming them.

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
  - While the device is offline, queued messages wait without using attempts. When it is back
    online they go out in order, each once. `remove(id)` takes back a failed or waiting message,
    for example to edit it.
- **Drafts and sign-out.**
  - Drafts are kept per person and conversation under `hamnivo:{widgetId}:draft:{scope}`.
  - `reset()` forgets the session, every unsent message and every draft on the device.
- **Streams.**
  - Streams use `fetch`, so the token travels in a header and never in the URL.
  - They reconnect with backoff and `Last-Event-ID`, and drop events already shown.
  - If nothing arrives within 45 s, not even a heartbeat, the stream reconnects.
  - On `auth_expired` the stream renews the session.
  - On `resync_required` the stream calls `onResync` and starts again from the new head.

## Checks

```bash
pnpm --filter @hamnivo/client test   # msw-backed unit tests: renewal, outbox, offline, files, streams
```

The browser journey in `apps/widget/e2e` exercises the same code against a real gateway.
