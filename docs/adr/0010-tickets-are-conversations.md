# ADR 0010: A ticket is a conversation

- Status: accepted
- Date: 2026-10-09
- Builds on: ADR 0001

## Context

Owners moving from tawk.to expect tickets: a message left while nobody could answer, with a
reference number, a state (Open, Pending, Closed), a priority, and answers by email. tawk.to keeps
tickets apart from chats.

Hamnivo keeps one transcript, in Chatwoot (ADR 0001). A separate ticket store would be a second
transcript, with its own sync, its own search and its own history to reconcile. Chatwoot already
has what a ticket needs: statuses, priorities (urgent, high, medium, low) and snoozing until the
customer writes.

Two Chatwoot facts shape the mapping:

- Chatwoot's `pending` status already means "the AI bot has it" in Hamnivo: a conversation starts
  `pending` while the AI owns it, and handing it to people opens it. A ticket's Pending cannot use
  it.
- Hamnivo follows only conversations its own widget started (`conversation_controls`). Email and
  WhatsApp conversations that Chatwoot creates itself are not followed yet.

## Decision

- **A ticket is a conversation with a number.** `conversation_inbox_state` gains the ticket's
  number (per tenant, from `tenant_counters`), how it became a ticket (`offline_form`, `staff`,
  `automation`) and when. A conversation never gets a second number.
- **The state is read from the conversation.**
  - Closed is resolved.
  - Pending is snoozed until the customer writes (Chatwoot's snooze without a time).
  - Open is everything else, including a snooze with a time.
- **The priority is Chatwoot's.** Hamnivo sets it through `toggle_priority` as the staff member and
  keeps a copy for queue filters; a change made inside Chatwoot comes back with the next state.
- **Tickets start from the widget or from staff.** The contact form (W11) makes one when nobody can
  answer, and staff can make any conversation a ticket. Hamnivo now adopts conversations that Chatwoot
  creates (ADR 0013); email and WhatsApp conversations become tickets with the email channel.
- **Answers by email go only to a confirmed address.** The contact form's address is typed, not
  verified. One email asks to confirm it and never repeats what was written, so a form cannot be
  used to send a third party text of someone else's choosing. Once confirmed, staff replies are
  emailed with their text (`customer.ticket_reply`). Replying by email arrives with the email
  channel; until then the email points back to the chat.

## Consequences

- One history, one search and one set of permissions for chats and tickets. The inbox gains a
  Tickets queue and filters by state and priority; reports count tickets from the same projection.
- Ticket references are per tenant (`#1042`), not per brand.
- A ticket's Pending depends on Chatwoot reopening a snoozed conversation when the customer writes,
  which is Chatwoot's behaviour and is covered by the contract suite.
- The tickets queue is ordered by recent activity like every queue; ordering by priority would need
  a different paging key and is left out for now.
