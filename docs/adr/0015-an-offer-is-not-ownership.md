# ADR 0015: An offer is not ownership

- Status: accepted
- Date: 2026-10-15
- Builds on: ADR 0003 (owner epochs), ADR 0011 (timed work runs on the outbox),
  ADR 0014 (reply-time targets)

## Context

Teams coming from Intercom, Zendesk or Freshdesk expect conversations to be pushed to one person
who accepts or declines them, instead of everyone watching one queue (HNV-10-03, HNV-10-06, H02).
Chatwoot Community Edition has auto-assignment, but it assigns without asking, cannot be
declined, knows nothing of the customer's language or of a person's limit, and its assignments
are ownership changes that Hamnivo then follows. Hamnivo already decides who owns a conversation
with the epoch-fenced transition (ADR 0003), so an offer has to fit that model without weakening it.

## Decision

- **Per team.** A team works in `queue` mode (everyone sees new chats; the default) or `offer`
  mode, with an offer time from 15 to 600 seconds (60 by default).
- **An offer is a row, not an owner.** `conversation_offers` records who was offered which
  hand-off (the ownership epoch it belongs to), which round, until when and how it ended. The
  conversation stays `WAITING_HUMAN` in the queue the whole time: the epoch does not move, the
  reply-time clock keeps running, the customer sees nothing, and anyone may still claim it.
  Accepting is an ordinary transition (`offer_accepted`) with `expectedEpoch` set to the offer's
  hand-off, so an accept that loses a race with a claim, a hand-back or a resolve changes nothing.
- **Who is offered.** Only people in the team who may read, reply to and take over the
  conversation there, who are online now (Studio open and used), who hold no other offer and are
  under their open-chat limit. Among them: those who speak the customer's language first (the
  language routing judged from their words, otherwise the one they chose; Hinglish counts as Hindi
  and Roman Urdu as Urdu), then the fewest open chats, then whoever waited longest since their
  last offer. Nobody is offered the same hand-off twice. Email is not offered: it waits in the
  queue as before.
- **Three people, then the queue.** A decline (with a reason: at capacity, not my area, going
  offline, other) or the end of the offer's time offers the conversation to the next person. After
  three, or when nobody can take it, the offers end (`offers_ended_at`, `offers_ended_epoch`) and
  the conversation waits in the queue.
- **Timers and fencing on the outbox.** Offers start after `conversation.route` and
  `conversation.team_changed` (whatever routing decided). Each offer queues
  `conversation.offer_timeout` for its end. Every step locks the conversation's control row and
  re-checks the hand-off, so a late timeout, a second click or a decline racing a claim does
  nothing. Owner changes, resolving and snoozing end a pending offer in the same transaction.
- **Alerts.** The person offered gets `chat_offered` (their "assigned" sound). The rest of the
  team does not get `chat_waiting` while a conversation is being offered; they get it when the
  offers end without anyone accepting. Going away or offline declines what is offered to the
  person at once, so the next person does not wait for the timer.
- **Records.** Offers, declines with their reasons, expiries and cancellations are audited.
  Ended offers are kept 90 days, then removed by maintenance (`app.purge_conversation_offers`).

## Consequences

- A team in offer mode should not also use Chatwoot's auto-assignment: an assignment made in
  Chatwoot is a change of owner, which ends the offer like any other claim.
- Presence comes from Studio's pings. Someone who closes Studio without choosing away is offered
  chats until their status lapses (about two and a half minutes); their offers simply time out.
- Round-robin without asking, skills beyond language, and reports on declines are not part of this
  decision; they can build on the offer records and the audit trail.
