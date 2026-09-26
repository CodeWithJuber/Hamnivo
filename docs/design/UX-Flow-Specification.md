# Hamnivo — UI/UX screen and state specification

**Status:** design handoff for mockups and implementation planning. These specifications do not mean that the application, integrations, accessibility conformance, financial operations or security controls have been implemented or tested.

**Coverage:** 28 canonical visual board groups and **168 concrete states** in `UX-State-Matrix.csv`. Each group has six state records with trigger, visible UI, primary action, recovery, role and privacy/access rule. A visual board may show a main screen and selected detail states; the CSV carries the complete named state inventory. This is a substantial baseline, not a claim to cover every permutation of devices, provider behavior and business rules.

**Brand:** Hamnivo. Existing research documents used the earlier working name Rifqo; the specifications in this kit use Hamnivo. The product is an embeddable support, conversation and agentic-commerce platform with customer, staff, tenant-admin and platform-admin surfaces.

## 1. Shared design contract

The interface should feel calm, deliberate and useful at high information density. Use the existing Hamnivo icon with ink `#192A30`, warm ivory `#F6F3EC` and restrained coral `#E45136`. Coral is an emphasis color, not a universal success/error/status signal. Verify contrast for every actual text/background pair; the palette alone is not proof of accessibility. Do not rely on color alone for privacy lanes, failures or queue priority.

Use one obvious primary action per local task. Keep secondary details in labelled drawers or expandable sections. Human support, permission scope, action approval and cancel/stop controls must remain easy to find. A minimal interface should remove duplication, not remove consequential information.

Use a compact app shell with a consistent navigation rail, page title, scoped search and utility actions. Staff work should fit in a list–conversation–context arrangement on wide screens. The context pane may collapse; it should not create unexplained empty right-side space. Do not make the user repeatedly reopen filters, scroll position or conversation context after every reply.

The customer widget uses its own isolated design tokens and container. Host-page navigation, colors and CSS must not leak into the widget unintentionally. A desktop popover becomes an intentionally full-height sheet on small screens. The customer can always collapse or close it without losing the conversation.

### Layout and responsive frames

| Surface | Primary design frame | Responsive behavior |
|---|---|---|
| Agent workspace | 1440 × 1000 | Three panes when useful; context drawer collapses first; list/chat become separate routes on narrow screens |
| Admin pages | 1440 × 1000 | Centered readable settings widths; tables use deliberate horizontal scrolling and sticky key fields |
| Website widget | 390 × 620 within host page | Launcher, welcome, conversation and handoff states share stable outer geometry |
| Mobile customer chat | 390 × 844 | Safe areas, reachable composer, keyboard-aware resize and visible close/back affordance |
| Mobile agent workspace | 390 × 844 | Queue → conversation → details navigation, with filters and drafts preserved |
| RTL reference | 1440 × 1000 and 390 × 844 | Mirror directional layout; isolate emails, code, IDs and amounts where their reading order is LTR |
| Component board | 1440 × 1000 or taller | Actual labels and state comparisons, with focused/pressed/disabled/error examples |

Final responsive checks should also include widths around 320, 360, 768, 1024 and 1920 CSS pixels, text enlargement and landscape orientation. These are handoff targets; they are not a statement that the raster mockups have been tested at every size.

### Content and interaction rules

- Mark AI participants as AI and human participants with their actual support role. The personality can be warm and frank without pretending an AI is a human.
- Use readable status language: “Sending”, “Waiting for a person”, “Payment confirmation pending”, “Action outcome unconfirmed”. Avoid “Done” before the responsible backend confirms it.
- Show sources, action summaries and decision outcomes; do not invent a hidden thought transcript or expose private staff context as a reasoning panel.
- Show uncertainty when information is incomplete. Do not display fabricated accuracy percentages, queue estimates, ROI numbers, reviews or customer logos.
- Use realistic illustrative data for mockups and label such examples as sample/demo content when they could be mistaken for measured business claims.
- Keep original-language messages accessible beside optional translations. Product names, order IDs, medication-like identifiers, monetary amounts and legal terms must not silently change in translation.
- Do not use a modal for every action. Reserve confirmation for changes with consequences, unsaved work and permission grants.
- Persist drafts with their tenant, conversation, recipient and lane. A private note must not become a public reply simply because the user switches mode.
- Every empty, error and blocked state needs a useful next action. “Something went wrong” alone is insufficient.

## 2. Canonical visual board map

| Board | Purpose and main composition | Essential state emphasis |
|---|---|---|
| 01 Workspace onboarding | Guided setup with live preview and completion checklist | New workspace, install waiting, verified connection, resumed setup, readiness review |
| 02 Sign-in and account security | Clear sign-in, verification and recovery screens | Loading, expired challenge, reauthentication, access revoked |
| 03 Workspace overview | Actionable queue and operational overview with command palette | Empty data, partial failure, role-filtered navigation, tenant switch |
| 04 Widget branding | Editor controls beside desktop/mobile widget preview | Draft, validation, publishing, published version and rollback |
| 05 Customer widget | Launcher, welcome, live conversation, human join and closure | Streaming, clarification, explicit identity, reopen |
| 06 Delivery and offline | Message bubbles and attachment states in their actual context | Queued, sent, failed, quarantined, reconnecting, new-message indicator |
| 07 Mobile and RTL | Mobile chat with keyboard, Arabic layout and translation details | Language ambiguity, mixed-script IDs, original text, sheet dismissal |
| 08 Shared inbox | Queue list, filters, priority reasons and assignment controls | Empty filter result, concurrent claim, bulk partial failure, overdue work |
| 09 Conversation workspace | Public timeline with clearly separated internal-note and agent-work views | Participant grants, reviewed AI draft, human takeover, stale output suppression |
| 10 Human–AI handoff | Customer waiting view and staff acceptance packet | No available human, timeout, cancellation, acceptance and ownership |
| 11 AI agent studio | Agent directory, identity, tools, knowledge and test preview | Draft, capability grant, simulation, blocked release, pause/rollback |
| 12 Jev decisions | Typed decision editor and compact decision/result inspector | Abstention, contract failure, unavailable provider, human correction |
| 13 Guardrails and approvals | Exact proposed action card with execution history | Approval expiry, denial, unknown outcome, emergency pause |
| 14 Knowledge and cache | Knowledge table, ingestion status, citations and cache overview | Parse failure, stale source, conflicting evidence, eligible cache hit |
| 15 Memory and correction | Subject memory profile with provenance and consent controls | Opt in/out, conflicting fact, correction propagation, deletion progress |
| 16 Learning and releases | Dataset eligibility, candidate comparison and release progression | Failed holdout, shadow-only run, canary scope, rollback |
| 17 Integrations and SDK | Connector directory, scoped authorization and installation console | Expired token, unsupported plugin, origin/CSP issue, test event |
| 18 Migration | Source → mapping → dry run → import → reconciliation wizard | Conflicts, unsupported data, checkpoint resume, per-record failures, cutover |
| 19 API and webhooks | Token scopes, event selection, deliveries and diagnostics | One-time secret, retry, dead letter, rate limit, version deprecation |
| 20 Shopping and checkout | Product comparison, cart, exact quote and checkout transition | Changed quote, provider authentication, pending confirmation, failed payment |
| 21 Orders and refunds | Order details, fulfilment timeline, refund/subscription controls | Delayed fulfilment, approval required, pending refund, renewal action |
| 22 Team and RBAC | Team table and scoped role editor with audit trail | Invitation expiry, permission conflict, safe offboarding and reassignment |
| 23 Analytics and billing | Defined metrics, drilldown, plan and usage | No data vs zero, language quality regression, quota limit, invoice failure |
| 24 Components and accessibility | Reusable control states and keyboard/screen-reader behavior | Hover, focus, pressed, disabled, invalid, loading, dialog and error |
| 25 NLP cache policy | Dedicated cache policy and provenance/quality console | Hit, miss, mandatory bypass, invalidation, outage, tier disable |
| 26 Platform super-admin | Operational health and tenant metadata, separated from customer content | Support-access request/grant/expiry, permitted failover, scoped incident action |
| 27 Voice and video | Device lobby, live call, captions and chat continuation | Permission denied, muted, camera off, interruption, reconnect, text fallback |
| 28 Workflow and hooks | Typed workflow builder with simulator and deployment review | Scope failure, recursive trigger blocked, test run, publish and safe rollback |

The broad knowledge/cache overview in board 14 introduces the feature; board 25 is the dedicated advanced cache-management surface. Likewise, board 17 covers connector installation while board 28 covers authored automation and plugin/hook execution behavior.

## 3. End-to-end UX journeys

### A. First workspace to first customer reply

1. Verified owner chooses workspace identity and region, then installs a channel through a short setup flow.
2. Connection status remains “Waiting” until a real handshake is observed. Show useful domain/CSP/snippet guidance on failure.
3. Owner configures basic branding, human availability and fallback route. A test room is labelled as test data.
4. Readiness review identifies required blockers separately from optional customization. Publish makes the selected configuration version live.
5. Customer opens launcher, sees AI identity and can start chat or request a person.
6. Customer message transitions through queued/sent states using one durable message identity. Agent/AI reply appears in the same thread.

**Failure contract:** preserve setup drafts; do not call the channel connected because a snippet was merely copied; do not advertise human availability unless an actual route exists.

**Relevant state groups:** 01, 04, 05, 06.

### B. AI assistance with private specialists and human takeover

1. Customer asks a question. Public responder receives only authorized public/declassified context.
2. Runtime may ask bounded specialist agents to work in the private agent-work lane. Staff can see permitted summaries and action events, not a fabricated internal-thought trace.
3. One authorized AI public speaker proposes or sends the answer according to review policy.
4. A direct request for a person immediately starts the configured human route. Jev may advise on additional escalation cases but cannot block that direct request.
5. Assigned human receives a concise packet: issue, language, completed operations, known facts and unresolved questions. Private notes retain their access boundary.
6. On acceptance, public ownership transfers. A takeover invalidates pending stale AI output. Already dispatched external operations remain visible as separate unresolved work until reconciled.

**Failure contract:** a timeout is not a human join; an absent human produces an honest follow-up option; reconnect must not reset queue position or revive a stale AI speaker.

**Relevant state groups:** 08, 09, 10, 12, 13.

### C. Knowledge-backed answer, memory and a customer correction

1. Retrieval uses sources allowed for the current user, tenant and purpose. The answer may present citation/date details without overwhelming the customer.
2. If sources conflict or evidence is insufficient, the assistant clarifies or escalates rather than inventing certainty.
3. Persistent memory is optional where appropriate and distinct from consent to training or evaluation reuse.
4. Customer can inspect, correct or delete an eligible remembered preference. Memory records carry source, time, scope and retention.
5. A correction updates canonical memory and invalidates dependent projections/cache versions. UI shows propagation until complete.
6. A delete request has a receipt and bounded scope. Retention exceptions, if any, need specific product policy rather than a vague “everything forgotten” claim.

**Failure contract:** unavailable memory falls back to asking for needed context; forbidden memory must not be revealed by hints or existence indicators; cache outage falls back to computation.

**Relevant state groups:** 14, 15, 25.

### D. Self-improvement without uncontrolled production changes

1. Reviewed interactions become eligible examples only under the applicable consent, purpose and retention rules.
2. The candidate explicitly identifies its mechanism: memory, prompt optimization, routing update or weight training. These are separate operations.
3. Candidate is evaluated with fresh/protected holdout procedures and language/case slices. Failure blocks promotion and points to concrete regressions.
4. Co-model runs in shadow with no authority to speak publicly or execute actions.
5. Authorized reviewer promotes a passing candidate into a limited canary with rollback thresholds and owner.
6. Regression causes a scoped rollback and incident review, while stable service remains identifiable.

**Failure contract:** no automatic promotion because the candidate scored well on its own training data; no “self-learning complete” screen that conceals required evaluation; privacy deletion propagates into eligible datasets.

**Relevant state groups:** 11, 12, 15, 16, 23.

### E. Conversation to approved order and financial recovery

1. Customer compares current merchant products and selects a draft cart. The AI does not invent stock or discounts.
2. Merchant source supplies exact quote, currency, recurring terms, taxes/shipping when known and expiry. Deterministic business services calculate totals.
3. Customer approves the exact proposal. A material change invalidates the old approval.
4. Payment occurs through the approved hosted-provider flow. Chat does not collect raw card details.
5. Browser return displays “Confirmation pending” until authoritative provider and order state confirm success.
6. Order fulfilment, cancellation, refund and subscription actions remain distinct states. A paid order can still await fulfilment; a requested refund is not a settled refund.

**Failure contract:** unknown write outcomes disable blind retry; inspect/reconcile the operation first. Duplicate messages/webhooks must not create duplicate purchases or refunds. Changed quotes require a new approval.

**Relevant state groups:** 13, 20, 21.

### F. Migration and go-live without silent data loss

1. Admin selects source, destination and import scope.
2. Mapping covers identities, timestamps/time zones, messages, attachments and source permissions; unsupported items are named.
3. Dry run displays record counts, conflicts, deduplication candidates and representative redacted examples without modifying live data.
4. Import proceeds with checkpoint and per-record status. Retry includes only failed eligible records.
5. Reconciliation compares source/destination totals and attachment/identity/ACL coverage.
6. Explicit cutover accounts for the live event cursor, possible overlap and rollback window.

**Failure contract:** no silent dropping of unsupported fields or failed files; cancelling a job does not imply already imported records vanished; restarting does not duplicate successful records.

**Relevant state groups:** 17, 18, 19.

### G. Controlled team, developer and platform operations

1. Tenant admin invites staff with queue/resource scope and permissions they are allowed to delegate.
2. Token and webhook setup use typed scopes, expiry, signed events and redacted diagnostics.
3. Offboarding revokes access and reassigns work; it does not leave active customer conversations ownerless.
4. Platform super-admin sees service health and tenant metadata by default, not automatic access to tenant transcripts.
5. Support content access requires an explicit purpose, resource scope, tenant authorization, duration and visible session banner. Revocation clears protected views promptly.
6. Workflow changes use a simulator and version review; running workflows retain an explicit version strategy. Recovery reconciles completed writes before replay.

**Failure contract:** UI visibility is never the authorization mechanism; role changes are checked server-side; a platform failover must honor tenant provider/data-location choices.

**Relevant state groups:** 17, 19, 22, 26, 28.

### H. Voice/video with equivalent text support

1. Customer chooses voice or video. Permission prompts explain the requested media; recording consent is separate.
2. Device lobby provides microphone/speaker test and optional camera preview. Denied camera access can fall back to audio or text.
3. Live call identifies human/AI participants and recording state. Captions and text chat remain available when supported.
4. Customer interruption stops AI speech promptly and returns to listening; a consequential action is still confirmed with an exact readable proposal.
5. Muted, camera-off and disconnected states are visibly distinct. Reconnection stays in the same conversation.
6. Text fallback preserves the support goal when devices, bandwidth or accessibility needs prevent a call.

**Failure contract:** no repeated permission nagging; no unlabelled recording; no implied agreement inferred from uncertain speech; no duplicate tickets on reconnect.

**Relevant state groups:** 07, 13, 27.

## 4. Reusable interaction-state contract

| State | Visual and UX behavior | Recovery or accessible alternative |
|---|---|---|
| Default | Legible label, clear action hierarchy, predictable hit area | Full keyboard route |
| Hover | Restrained emphasis, never the only place a label appears | Equivalent keyboard focus presentation |
| Focus-visible | Clear high-contrast focus boundary, not clipped by container | Preserve logical tab order |
| Pressed/selected | Immediate feedback and semantic selected state | State distinguishable beyond color |
| Disabled | Reason visible near unavailable action | Explain what enables the action; do not hide prerequisite |
| Read-only | Content selectable and labelled as read-only | Explain permission/policy without offering bypass |
| Loading | Stable geometry, bounded progress and accessible status | Timeout leads to useful retry; duplicate submit blocked |
| Empty | Correct distinction between no records and no matches | Create first item or reset filter |
| Invalid | Inline message and linked summary, values preserved | Focus first invalid field after attempted submit |
| Recoverable error | Specific safe reason, reference ID when useful | Retry the failing operation only |
| Partial failure | Successful portions remain usable | Retry failed subset; show precise counts |
| Offline | Honest connectivity state, last sync and draft retention | Reconnect and reconcile events before claims of current state |
| Pending external state | Distinguish dispatched/accepted/confirmed | Reconcile before repeating a side effect |
| Unsaved changes | Preserve draft and show save/discard/stay choices | Never silently drop work on route change |
| Success | Confirm exact completed effect and next step | Undo where genuinely supported; otherwise explicit corrective action |

Menus, dialogs, drawers and popovers need initial focus, focus containment where appropriate, keyboard operation, a visible close option and return of focus to the trigger. Toasts can supplement persistent state but must not be the only place to discover a failed payment, revoked permission or lost connection.

Screen readers need meaningful landmarks, labelled controls and restrained live-region announcements. Announce response completion or useful chunks rather than every streamed token. Reduced-motion preferences should remove decorative movement while preserving status visibility. Zoom and large text must not obscure the composer or primary controls.

## 5. Microcopy direction

| Situation | Example intent |
|---|---|
| AI introduction | “I’m Hamnivo’s AI assistant. I can help here, or connect you with a person.” |
| Uncertainty | “I couldn’t confirm that from the available information. Let’s check the source or ask the team.” |
| Human queue | “Your request is with the support team. You can keep this chat open or leave a reply address.” |
| Private note | “Internal note · visible to authorized teammates only” |
| Unknown action outcome | “The request was sent, but the result is not confirmed. We’re checking before trying again.” |
| Payment pending | “Your payment confirmation is still pending. Please don’t place the same order again yet.” |
| Memory choice | “May I remember this preference for future chats? You can change or delete it later.” |
| Hindi/Hinglish warmth | “Main AI assistant hoon. Aap chahein to support team se bhi baat kar sakte hain.” |

Final translation needs native review for tone, dialect, terminology, pluralization and contextual clarity. Warmth should not become flattery, agreement with an incorrect claim, or a false promise. Prices, availability and policies must come from authoritative business data.

## 6. Handoff acceptance and remaining gaps

Before implementation, product owners must finalize allowed channels, precise role grants, supported provider versions, actual commerce/refund terms, memory-retention rules, support-access policy, required languages and plan limits. Mockups may demonstrate these settings but must not invent binding business policy.

Before release, engineering and QA must verify the consequential paths represented here: message deduplication/reconnect, server-side access filtering, private-lane isolation, human takeover, approval binding, payment reconciliation, deletion propagation, import cutover, RTL/keyboard access, voice permissions and workflow recovery. Visual review alone cannot validate them.

The 168 rows intentionally avoid enumerating every possible responsive × locale × role × state combination. Derive those combinations from reusable components and role contracts, then prioritize real risk: public/private leakage, wrong-tenant data, duplicate financial effects, inaccessible human support, unrecoverable drafts and misleading completion states.

Use the CSV IDs in design annotations, implementation tickets and review comments. Record implementation status separately from this design inventory; a mockup existing does not mark its state as built or tested.
