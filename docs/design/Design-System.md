# Hamnivo — UI system and implementation handoff

Design date: 27 September 2026. These are static visual concepts and specifications for the proposed product. They are not implemented screens, verified integrations, or measured product results. Example people, orders, metrics, snippets and timestamps are fictional.

## Product hierarchy

Customer: ask, understand the responder, retain context, approve a precise action, recover when something fails. Agent: triage, understand, respond, collaborate, resolve. Tenant administrator: configure, test, publish, inspect and undo. Platform operations is a separate console; tenant content requires an explicit support grant.

Use progressive disclosure. Keep the ordinary reply path simple. Put technical agent/tool traces behind a named activity view for authorized staff. Do not put provider IDs, cache internals or policy jargon into the customer conversation.

## Colour tokens

| Token | Value | Intended use |
|---|---|---|
| ink | #192A30 | Body text, headings, primary filled actions |
| ivory | #F6F3EC | Quiet workspace background and secondary surfaces |
| white | #FFFFFF | Working canvas, form fields, message areas |
| coral | #E45136 | Active indicator, decorative accent, selected edges |
| rust | #A22F20 | Underlined text links and errors with text/icons |
| sage | #26724B | Success foreground on a verified light surface |
| amber | #855B12 | Caution foreground on a verified light surface |

Calculated sRGB contrast: ink/white 14.84:1; ink/ivory 13.39:1; coral/white 3.80:1; rust/white 7.09:1. These are token-pair calculations, not a pixel audit of generated artwork or a claim of product accessibility compliance. Use ink or rust for small text. Coral text visible in concept renders must be replaced with rust or ink in implementation. Our ordinary text target is at least 4.5:1.

Never rely on colour alone for AI/human identity, priority, validation, delivery, payment or approval. Pair status with readable text and a distinct icon.

## Type and geometry

- Proposed UI font: a humanist sans such as DM Sans, with Noto Sans Arabic/Devanagari fallbacks. Font assets and licences must be checked during implementation.
- Desktop body 14–16 px; mobile body 16 px; labels 13–14 px; main page heading 24–28 px. Avoid using tiny grey text for required decisions.
- Spacing scale: 4, 8, 12, 16, 24, 32 px. Form rows use at least 12 px internal separation and 24 px between meaningful groups.
- Corners: 8 px inputs, 10–12 px menus/dialogs, up to 16 px customer widget. Avoid making every element a pill.
- Desktop controls 40 px minimum nominal height; touch controls target 44 px or larger. Icons 18–20 px within a labelled control. No icon-only destructive or approval action without an accessible name.
- Desktop canonical viewport 1440×1024; mobile content viewport 390×844. Generated image dimensions can differ; these are layout targets, not export-size guarantees.

## Responsive rules

Large screens show inbox list, transcript and optional customer context. Collapse context into an explicitly opened drawer before reducing transcript readability. At narrow widths use one primary surface at a time: queue → conversation → details, with a clear back action. Preserve selected conversation, draft, scroll position and unread markers.

Customer widgets become full-height content panels on small screens, keep the composer above the on-screen keyboard, and respect safe-area insets. Do not embed a desktop app screenshot inside a mobile viewport. Horizontal scrolling is deliberate only for appropriate tab or comparison groups, with a visible affordance. Core content must not create accidental page overflow.

Use logical CSS properties for RTL, isolate LTR order IDs/emails/amounts, and keep translated and original messages separately available. Arabic and Urdu require native-reader review. Layout mirroring alone does not establish language quality.

## Component behaviour contract

Every control has default, hover (pointer devices), focus-visible, pressed, disabled-with-reason and busy states as applicable. A busy button retains its label context and prevents duplicate submission. A disabled action explains what unlocks it; do not replace an authorization explanation with a silent grey button.

Menus and dialogs support keyboard navigation, Escape and focus return. Trap focus only in modal surfaces. Toasts do not carry the only copy of a failure. Important outcomes also persist in the relevant screen. Respect reduced-motion preferences; skeletons and progress indicators must have accessible status text.

Forms keep entered values after errors, associate error messages with the corresponding inputs and place keyboard focus meaningfully. Search supports query clearing, no-results recovery and visible applied filters. Lists distinguish loading, empty, filtered-empty, partial data and failed loading.

## Conversation and action behaviour

Keep public conversation, private staff notes and agent activity visually and technically separate. Show AI and human identities accurately. Human takeover pauses new public AI replies; staff can inspect outstanding actions before resuming automation. An invitation reveals exactly what history and tools the specialist receives.

Message states are queued locally, accepted by server, delivered, read where supported, failed and cancelled. Reconnect must reconcile server state before retrying. Do not create a second order, charge, refund or message because a response was lost.

An action preview names the affected resource, exact values, price/currency when relevant, expiry and permitted approver. Approval is not execution. Payment return redirects are not payment receipts. Unknown outcomes stay pending until authoritative reconciliation.

Jev supplies typed advice. Deterministic policy and authenticated grants authorize action. A direct customer request for a person must remain available even if a classifier would prefer automation. Provider failures use a named fallback and preserve the conversation.

Memory is scoped, inspectable and correctable. Distinguish a user's original statement, an inference and an approved correction. Deletion has progress and completion receipts. Learning presents proposed changes, independent evaluation, shadow/canary state, approval, version and rollback. No interface promise of autonomous self-improvement without these controls.

## Copy and visual review requirements

Use short, candid messages: what happened, what remains safe, and what to do next. Do not imply that the AI is a human, always available staff, permanently secure, unbiased, perfectly accurate, or certain of an outcome it cannot verify. Replace absolute phrases such as “We’ll never share your details” with a specific privacy explanation or policy link.

Numbers in mockups are illustrative and may differ between boards. They are not one coherent live dataset. Implementation must use a consistent seeded fixture for end-to-end flows, including totals, currencies, order states and role names. Do not copy illustrative integration snippets into production without the final API contract.

## Release validation still required

The design kit is reviewable visual direction. Implementation needs interaction tests for drafts/retry/idempotency, server authorization, cross-tenant isolation, actual native-language QA, keyboard/screen-reader testing, zoom/reflow, contrast at rendered sizes, provider and payment integration tests, responsive screenshots, and user testing with customers, agents and administrators. The state matrix defines expected behaviour but does not prove it works.
