# ADR 0014: Reply-time targets are business-time clocks Hamnivo keeps

- Status: accepted
- Date: 2026-10-15
- Builds on: ADR 0001 (Chatwoot is the conversation authority), ADR 0003 (owner epochs),
  ADR 0011 (timed work runs on the outbox)

## Context

Teams moving from Intercom, Zendesk or Freshdesk expect reply-time targets: a deadline per
conversation, an overdue list and an alert. Chatwoot Community Edition has no SLA feature, so
Hamnivo cannot read one from the authority. Business hours (W11) already live with each brand in
Hamnivo, and the inbox list is served from Hamnivo's own projection (`conversation_inbox_state`),
so a clock can be kept next to the rows it sorts and filters.

## Decision

- **Targets per brand, per priority.** `sla_policies` holds, for each brand, "first reply
  within" and "next reply within" for urgent, high, medium and low (1 minute to 7 days, or none).
  A conversation with no priority uses medium. Changing targets or business hours recomputes the
  brand's open clocks (`brand.sla_resync` on the outbox).
- **A stored clock, not a derived one.** Each conversation keeps its clock in
  `conversation_inbox_state`: kind, start, target, pause, paused minutes, due time and when it
  went overdue. One pure function (`nextSlaClock` in `@hamnivo/domain`) decides the next clock from
  stored facts; the gateway calls it after every change that can move it (a customer message, a
  person's public reply, an owner, status or priority change). The list then filters and sorts by
  an indexed `sla_due_at`, and nothing is recomputed on read.
- **Business time.** Minutes count only inside the brand's business hours, in its time zone,
  across daylight-saving changes and closed dates; no hours means every minute counts. Snoozed
  time is added to the deadline, rounded up to whole minutes.
- **People's replies only.** Only a public reply from a person ends the clock: one sent from
  Studio, or one made in Chatwoot by a user (without a Hamnivo AI or automation key). The clock
  runs only while a person owns or is asked to own the conversation; a hand-back to the AI ends it.
- **Deadlines on the outbox.** A moved deadline queues `conversation.sla_due` for that time. The
  handler locks the conversation and recomputes; a check for a deadline that moved finds nothing to
  do. Going overdue is audited once (`conversation.sla_breached`) and becomes an `sla_overdue`
  alert for the owner, or for everyone who can see a conversation nobody has taken.
- **A claim that loses says who won.** `OWNERSHIP_CHANGED` problems carry `currentOwner` (kind,
  display name, epoch), shown only to people who may read the conversation.

## Consequences

- The clock is as fresh as the last event Hamnivo processed; a Chatwoot reply arrives with the
  next webhook or reconciliation.
- Escalation (reassigning an overdue conversation, a supervisor alert) and reports on targets met
  are not part of this decision; they can build on the stored clocks and the audit trail.
- Chatwoot does not show the targets. A team working only in Chatwoot does not see them.
