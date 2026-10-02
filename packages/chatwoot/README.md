# @hamnivo/chatwoot

The Chatwoot CE **v4.18.0** connector. Chatwoot is Hamnivo's conversation authority (ADR 0001). It
owns contacts, conversations, messages, private notes, status, assignment and labels. This package
is the only code that knows Chatwoot's API. Everything else uses the `ConversationAuthority` port
from `@hamnivo/domain`.

| Module | What it does |
|---|---|
| `src/client.ts` | Typed Platform, Application and Client API clients, generated from the vendored swagger with openapi-typescript and called with openapi-fetch. Requests time out (10 s by default). `ChatwootError` reports the HTTP status and whether a retry is safe (timeouts, 429 and 5xx). |
| `src/authority.ts` | `ChatwootAuthority` implements `ConversationAuthority`. Every write runs with the credential of the actor behind it: the AI agent bot, the integration user, or the staff member's own Chatwoot user. Chatwoot's attribution and permissions therefore stay truthful. |
| `src/mapping.ts` | Converts Chatwoot JSON (API responses and webhooks) into authority messages and conversation state. |
| `src/webhooks.ts` | Signature verification (`sha256=HMAC(secret, "{ts}.{body}")`, ±5 minutes, constant time). Also event normalization, dedupe keys and redaction of credentials before storage. |
| `src/provisioning.ts` | Creates a connected account: an integration user, an API inbox with mandatory HMAC identity and auto-assignment off, the AI agent bot, a signed account webhook and the Copilot dashboard app. It refuses to adopt existing Chatwoot users. |
| `src/migration.ts` | `ChatwootImporter` writes imported history (migration): the import inbox, contacts without email or phone, conversations found again by a key attribute, messages with their original time and `source_id`, file attachments, resolving, and deletion for rollbacks. It also reads what could act on imports (automation rules, integration hooks, inbox settings). |
| `src/fake/` | A fake Chatwoot for tests, with faithful payloads, permissions, assignment rules, paging and signed webhooks. It can duplicate, drop, delay or reorder webhook deliveries. It logs every request and what Chatwoot would send outside itself (reply emails, greetings). |

## Chatwoot behaviour this package relies on (verified on v4.18.0-ce)

### Messages

- Customer, AI and note messages go through the Application API with `source_id = hv1:…`, which
  Chatwoot echoes in responses and webhooks.
- Chatwoot does **not** deduplicate `source_id`. After a timeout, callers resolve the unknown outcome
  with `findByKey`, never by posting again.
- Message lists page 20 at a time going backwards (`before`) and 100 at a time going forwards
  (`after`).
- The customer view comes from the Client API, which excludes private notes and activity messages.
- Bot tokens can post messages and change conversations, but cannot list messages. Reads use the
  integration user.

### Files, deletion and read markers

- A message with files is `multipart/form-data` with `attachments[]`. `content_attributes` sent
  as a JSON string keeps its types; bracket fields (`content_attributes[hv][v]`) turn numbers
  into strings.
- Attachment JSON has no file name. The name is the last segment of `data_url`, an
  ActiveStorage `/blobs/redirect/{signed id}/{name}` URL on Chatwoot's `FRONTEND_URL`. The
  customer view (Client API) may list a message's files in another order than the response that
  created it.
- `downloadAttachment` reads `/rails/active_storage/blobs/proxy/{signed id}/{name}` on the
  connection's own base URL, with redirects refused. Only the signed id and name are taken from
  `data_url`; its host is never contacted.
- `DELETE …/messages/{id}` (the integration user, or an agent of the inbox) keeps a marker:
  the content becomes "This message was deleted", `content_attributes` becomes `{deleted: true}`,
  the files are removed, and `message_updated` is sent.
- Staff opening a conversation (`POST …/conversations/{id}/update_last_seen`) sets
  `agent_last_seen_at` (Unix seconds on the conversation, 0 before; ISO in message-list `meta`).
  Chatwoot writes the column directly: no webhook, and `updated_at` does not move.
- The Client API's `update_last_seen` records that the contact saw the conversation and marks
  agent messages sent before then as `read`.

### Contacts and identity

- Contacts are created through the Client API with `identifier_hash = HMAC(inbox hmac_token,
  identifier)`. Hamnivo supplies the secret `source_id` itself, so retries return the same contact
  inbox.
- A wrong hash on an `hmac_mandatory` inbox makes Chatwoot fail with HTTP 500 (an unhandled
  `StandardError`).
- `POST /platform/api/v1/users` returns an existing user when the email is already taken. It also
  grants the Platform App access to that user. Provisioning sends a one-time nonce in
  `custom_attributes`, which only a newly created user echoes back, and raises
  `ChatwootUserAdoptedError` otherwise.

### Ownership and status

- A conversation in an inbox with an agent bot starts `pending`, with `meta.assignee_type =
  'AgentBot'`.
- A bot setting `open` hands the conversation off: the bot lets go and the conversation waits for a
  person.
- Assigning a user clears the bot and opens a pending conversation.
- Assigning `assignee_type: 'AgentBot'` sets the bot and makes the conversation `pending`.
- `assignee_id: null` clears both and leaves the status unchanged.

### Imported history

- `external_created_at` is kept only in the message's `content_attributes`. Chatwoot stores its
  own `created_at`, orders messages by it and shows it in its dashboard, so imports write messages
  in their original order and Hamnivo shows the original times.
- A top-level `external_created_at` is lost when the same request also sends
  `content_attributes`; the original time therefore always travels inside `content_attributes`.
- Application API contacts are created as given: no merge by email. A second contact with the same
  identifier is refused (HTTP 422), and `contacts/search` finds it by identifier.
- Chatwoot emails an outgoing public message on an API inbox when the contact has an email and the
  account has email continuity on. Imported contacts never get an email or phone number.
- Deleting a conversation is asynchronous (it disappears within seconds). Deleting a contact also
  deletes its conversations.
- `(mention://user/…)` links in private notes notify the mentioned staff, so imported text has
  them turned into plain names first.

### Webhooks

- Account webhooks receive every event. The API inbox webhook receives conversation, message and
  typing events. The bot webhook receives message and conversation events.
- Each source signs with its own secret. Chatwoot does not retry account or inbox deliveries, so the
  gateway reconciles.
- The bot copy serializes `updated_at` with more float digits than the account copy. Dedupe keys
  therefore compare versions in milliseconds and hash the state.
- Webhook payloads contain the contact inbox `source_id`. `redactChatwootPayload` removes it before
  anything is stored.

## Tests

```bash
pnpm --filter @hamnivo/chatwoot test        # unit tests + the contract suite against the fake
pnpm chatwoot:up                             # a real Chatwoot 4.18.0 (see docs/self-hosting.md)
set -a; . ./.env.local; set +a
pnpm --filter @hamnivo/chatwoot test:int    # the same contract suite against the real one
```

`pnpm ci:local` runs the real-Chatwoot suite in a throwaway stack.

The payloads under `test/fixtures/v4.18.0/` were captured from a real v4.18.0-ce, with credentials
and source ids scrubbed.

## Regenerating the client

The swagger file is vendored from the `v4.18.0` tag. `swagger/overlay.json` adds fields and
endpoints that exist in Chatwoot's code but are missing from its swagger. Examples are message
`source_id` and `sender_type`, `POST /platform/api/v1/users/{id}/token`, and dashboard apps.

```bash
pnpm --filter @hamnivo/chatwoot generate    # writes src/generated/chatwoot.ts
```

`pnpm test` fails when the generated file is out of date.
