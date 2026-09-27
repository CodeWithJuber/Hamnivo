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
| `src/fake/` | A fake Chatwoot for tests, with faithful payloads, permissions, assignment rules, paging and signed webhooks. It can duplicate, drop, delay or reorder webhook deliveries. |

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
