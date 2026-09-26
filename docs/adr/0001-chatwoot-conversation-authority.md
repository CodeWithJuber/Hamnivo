# ADR 0001 — Chatwoot CE is the conversation authority

- Status: accepted (2026-09-26)
- Blueprint: §1 "fast launch alternative", §2, §7, §20

## Context

The blueprint offers two foundations: a product-owned conversation core, or Chatwoot Community
Edition behind an adapter. The owner chose Chatwoot. The blueprint's rule for that route is that
Chatwoot owns conversation state and Hamnivo must not independently mutate a second transcript.

## Decision

- Pin Chatwoot CE **v4.18.0** (`chatwoot/chatwoot:v4.18.0-ce`).
- Chatwoot owns contacts, conversations, messages (public and private notes), status, assignee and
  `ai_assignee`, labels, custom attributes, CSAT, business hours, attachments and channels.
- Hamnivo owns identity, tenancy and grants; per-conversation control records (owner mode, owner
  epoch, AI speaker lease); idempotency and publication ledgers; participants and history grants;
  cases, tasks and handoff packets; AI runs, tools, approvals, operations and receipts; Jev decision
  records; knowledge; memory and learning; commerce; audit, usage, SLA, custom roles and capacity.
- All access goes through `ConversationAuthorityPort` (`packages/domain`). Only `packages/chatwoot`
  implements it and no Chatwoot type crosses the port, so a native core can replace Chatwoot later.
- The browser never calls Chatwoot. The widget and Studio talk to the Hamnivo gateway.
- Hamnivo keeps a short-lived realtime journal (7-day TTL) derived from Chatwoot for SSE replay. It is
  a projection, never edited independently, and redacted when Chatwoot deletes content.

## Consequences

- Chatwoot account/inbox webhooks are not retried, so a reconciler polls Chatwoot for completeness.
- Chatwoot has no compare-and-set on message creation: human takeover fencing has a narrow residual
  race that Hamnivo detects and reports (ADR 0003).
- Chatwoot CE lacks audit logs, SLA, custom roles and agent capacity (enterprise-only); Hamnivo builds them.
- Chatwoot conversations have exactly one contact, which limits group conversations, guests, reactions
  and customer edits; those features ship as documented Hamnivo overlays.
- Chatwoot's own agent UI stays usable; Hamnivo Copilot is embedded there as a Dashboard App.
