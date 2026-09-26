# ADR 0003 — Human takeover uses an owner epoch with fenced publication

- Status: accepted (2026-09-26)
- Blueprint: §12 "Ownership and state", §21 "Turn-taking", R05, R06, R07, H08

## Decision

Each conversation has a Hamnivo control record with `owner_mode`
(`AI_ACTIVE | WAITING_HUMAN | HUMAN_ACTIVE | PAUSED`) and a monotonically increasing
`ownership_epoch`, mirrored onto Chatwoot state (`ai_assignee`, `assignee`, status).

- Every owner change is one transaction: row lock, `ownership_epoch++`, outbox event. The Chatwoot
  mutation follows through the outbox, so retries are safe because the local fence already exists.
- An explicit "talk to a person" request is deterministic precedence 1: it moves the conversation to
  `WAITING_HUMAN` immediately; Jev is never consulted and cannot veto it.
- Fenced publication for any AI message or tool dispatch:
  1. in a transaction, check epoch, `AI_ACTIVE`, lease and grant; insert a `publications` row;
  2. pre-flight read of Chatwoot state (our `ai_assignee`, no human assignee);
  3. create the message with `source_id` (idempotent);
  4. mark the publication sent.

## Residual limit

Chatwoot cannot compare-and-set. A human assignment committed between steps 2 and 3 can let one
stale AI message through. Hamnivo detects it (event ordering by `updated_at`), marks the publication
`late_publication`, adds a private note for the new owner, writes an audit event and alerts. It never
silently deletes the message. External operations that were already dispatched are reconciled by the
new owner, never assumed undone.
