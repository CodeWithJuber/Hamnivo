# ADR 0016: Overdue conversations escalate to the people who can assign them

- Status: accepted
- Date: 2026-10-16
- Builds on: ADR 0003 (owner epochs), ADR 0011 (timed work runs on the outbox),
  ADR 0014 (reply-time targets), ADR 0015 (an offer is not ownership)

## Context

ADR 0014 made overdue conversations visible: a badge, the Overdue queue, one audit row, and an
alert for the owner (or, for a conversation nobody has, everyone who can answer it), heard only
if their Studio is open. Nobody else hears about it, nothing is emailed, and nothing takes the
conversation from a person who is away. Teams coming from Zendesk, Freshdesk or Intercom expect
an overdue conversation to reach a lead and, if it stays unanswered, to move to someone who can
answer (H12). Chatwoot Community Edition has neither.

## Decision

- **Per brand, next to its targets.** `sla_policies` gains three columns:
  - `overdue_alert_leads`: alert the leads when a conversation goes overdue;
  - `overdue_move_after_minutes`: working minutes after that before it is moved (1 minute to
    7 days; null: never);
  - `overdue_move_team_id`: the team it goes to; null means back to the queue, keeping its team.
    The team must be active and take the brand's conversations, as when a person moves one.
- **Leads are the people who can assign the conversation.** Active staff whose role, at the
  conversation's workspace, brand, team or inbox, allows `conversations.read` and
  `conversations.assign`: owners, administrators and supervisors by default. There is no separate
  team-lead setting; a narrower grant makes a narrower lead.
- **Triggered where the breach is found.** `syncSla` already detects each new breach once, inside
  the transaction that moved the clock. There it queues `conversation.sla_alert` (due now) and
  `conversation.sla_move` (due after the extra working minutes, counted in the brand's business
  hours like the targets). Every path that moves a clock is covered.
- **The Studio alert is derived, not stored.** The inbox stream already reads `slaBreachedAt`. A
  person who may assign the conversation but is not otherwise concerned gets `sla_overdue_lead`
  once per deadline, with the same key as `sla_overdue`, and hears nothing else about a colleague's
  conversation.
- **Email when a lead is not online.** The alert step emails leads whose status is not online
  (ADR 0015's availability), except the conversation's owner, who already hears it. One email per
  lead and brand per 15 minutes, however many go overdue at once.
- **The move is fenced.** Under the conversation's lock, after recomputing the clock, the
  conversation moves only if it is still the same overdue clock (same `breachedAt`), with the same
  owner epoch and team as when it went overdue, not snoozed, and the brand still asks for it. A
  reply, the AI taking it back, resolving, snoozing, a claim or a reassignment all stop it.
  - A conversation someone has goes back to the queue (reason `sla_moved`, actor `sla`), with the
    chosen team set first, and a private note in Chatwoot says why.
  - A conversation already waiting moves only to another team. `OwnershipService.transition`
    gains `requeue`, so this is a new hand-off (a new epoch): the new team's offers start
    (ADR 0015), and its AI draft is kept.
  - The clock stays overdue after a move: no second breach, no second alert, and the reply-time
    record (`sla_outcomes`) is written when someone finally replies.
- **No storm from settings.** A deadline that had already passed when the brand saved its
  targets is not escalated, so shortening a target does not email about or move the backlog.

## Consequences

- An overdue conversation reaches someone who can act on it even when its owner is away, and
  moving it never takes it from someone who acted.
- The customer sees only that they are waiting for a person again; no message is sent.
- A change to business hours can still make conversations overdue at once and escalate them.
- Leads are notified by permission, not by name. A brand that wants one named lead gives that
  person the assign permission on the team and nobody else.
- Chatwoot shows the move as an unassignment, with the private note.
