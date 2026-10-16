# ADR 0017: Retention deletes old conversations everywhere and keeps an anonymous report row

- Status: accepted
- Date: 2026-10-16
- Builds on: ADR 0001 (Chatwoot holds the conversation), ADR 0011 (timed work runs in the worker),
  ADR 0013 (Hamnivo follows every conversation in its Chatwoot account)

## Context

A10 asks for a retention policy a workspace can set, and a documented customer data export. Until
now every period was fixed: the realtime journal 7 days, visitors 30, drafts and offers 90, reply
clock outcomes 13 months. Nothing ever deleted a conversation, its records or the customer behind it,
in Hamnivo or in Chatwoot, so a business could not honour "we keep chats for a year".

Three things make deleting a conversation more than one `DELETE`:

- Chatwoot holds the transcript and the files. Deleting only Hamnivo's copies keeps the personal
  data where most of it is.
- Reports read conversations: `conversation_metrics` had a cascading foreign key to the
  conversation, and the commerce, AI, work-queue, CSAT and ticket reports joined through it. Deleting
  a conversation would silently rewrite last year's numbers.
- A conversation leaves records in about 25 tables, several append-only for the application role
  (decisions, drafts, approvals, notifications), so that the application cannot erase what happened.

## Decision

- **One policy per workspace, off by default.** `retention_policies` holds `conversation_days`, one
  of 90 days, 6 months, 1, 2, 3, 5 or 7 years, or null (keep everything). Only owners hold
  `privacy.manage`, with a recent sign-in and two-step verification; it cannot be given to an API key.
- **Deleting sooner waits a week.** Turning retention on or shortening it is stored as a pending
  change that takes effect 7 days later; saving the period in force again undoes it. Keeping things
  longer, or forever, applies at once. Every owner is emailed on each change, with the date.
- **The worker deletes, Chatwoot first.** Every 10 minutes it takes the oldest resolved conversations
  past their workspace's cutoff (at most 100, 25 per workspace; `RETENTION_BATCH`,
  `RETENTION_PER_WORKSPACE`). For each it checks, under the conversation's lock, that it is still
  resolved and old and that no message is on its way; asks Chatwoot, which is the record, that it is
  resolved and inactive there too; deletes it in Chatwoot; then deletes it in Hamnivo with
  `app.retire_conversation`, which checks the same again at the database's clock.
  - A conversation reopened or written to in the meantime stays.
  - Chatwoot answering 401 or 403 (its Hamnivo user is not an administrator) stops the workspace's
    sweep before anything is deleted in Hamnivo, and Studio says so. Other failures are tried again
    on the next run; every step can run twice.
- **Deleting in Hamnivo goes through definer functions** owned by `hamnivo_resolver`, which may
  delete exactly the rows a conversation leaves and nothing else. The application still cannot
  delete from append-only tables.
- **What stays.** Business records and what reports count stay, without anything about the customer
  or what was said:
  - `conversation_metrics` loses its foreign key and keeps the conversation's row, now marked
    `retired_at`, with copies of its team, priority, ticket and ratings. Reports read live records and
    these copies side by side, so their numbers do not change.
  - Orders, payments and refunds, reply clock outcomes, offers, AI run counts and person-scoped
    memory keep their own retention; their foreign keys to the conversation are dropped.
  - The audit log is never deleted from. It holds ids and counts, never content.
- **History only Chatwoot has.** Hourly, the sweep also lists each of the workspace's inboxes in
  Chatwoot, resolved conversations least recently active first, and deletes old ones Hamnivo never
  followed (imported history, chats never adopted).
- **Customers left with nothing.** Hourly, a customer with no conversation left, nothing bought, no
  live chat session and not seen since the cutoff is removed: their Chatwoot contact when it has no
  conversation there either, their memory through the memory deletion path (with its receipt and
  tombstones), then the customer. Consent records stay: they prove what was agreed and hold only an
  id.
- **Handled outbox events** are deleted after 30 days, since some carry message text.

## Consequences

- A workspace can keep conversations for as long as it needs and no longer, and its reports stay
  the same.
- Deleted conversations cannot be brought back. Backups keep them until they rotate out (the newest
  14 by default), and a restore brings them back until the next sweep deletes them again.
- The first sweep after turning retention on can take days on a large workspace (about 3,600
  conversations a day per workspace at the defaults).
- A customer who writes in the milliseconds between the checks and the delete, after at least 90
  days of silence, can lose that message.
- Data already sent elsewhere is out of reach: webhook deliveries to the business's systems and
  transcripts already emailed.
- Customer export and erasure on request are ADR 0018.
