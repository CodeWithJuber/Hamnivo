# ADR 0004 — Realtime delivery: journal + SSE + reconciler

- Status: accepted (2026-09-26)
- Blueprint: §7 "Durable message delivery", W05–W07

## Decision

- A message is acknowledged to a client only after Chatwoot has committed it. Customer and AI messages
  are written through the Chatwoot Application API with a deterministic `source_id` (`hv1:…`), so a
  retry after a timeout is resolved by lookup, never by blind re-posting.
- Chatwoot webhooks are verified (HMAC over `{timestamp}.{raw body}`), stored in an inbox table with a
  dedupe key and acknowledged quickly; a worker normalizes them into the Hamnivo event envelope.
- Events are appended to a per-conversation journal with a gapless `seq` assigned under the control
  record lock. SSE clients resume with `Last-Event-ID`; an expired cursor yields `resync_required`.
- Chatwoot does not retry account/inbox webhooks, so an adaptive reconciler polls active conversations.
- Valkey pub/sub only signals "sequence advanced"; clients always read from PostgreSQL by cursor.
- The system is at-least-once with idempotent consumers. It is not described as "exactly once".
