# @hamnivo/gateway

The Hamnivo Gateway: one codebase, two processes, both built on NestJS 12 and Fastify 5.

| Process | Entry | Does |
|---|---|---|
| API | `src/main.api.ts` | REST API, staff sign-in at `/api/auth/*` (Better Auth), administration, OpenAPI at `/v1/openapi.json` and `/docs`, health, metrics |
| Worker | `src/main.worker.ts` | Outbox relay (at-least-once), BullMQ maintenance: audit partitions and expiry purge |
| Migrations | `src/main.migrate.ts` | Applies pending database migrations as the schema owner (`DATABASE_OWNER_URL`), then exits |
| Platform operators | `src/main.operator.ts` | Names, changes or disables a platform operator as the schema owner, then exits (`<email> <role>` or `<email> --disable`) |

In production, all three run from one image (`deploy/docker/Dockerfile`, target `gateway`); see
`docs/self-hosting.md`, Part A. The worker rewrites `WORKER_HEARTBEAT_FILE` after every outbox
pass, and the container health check reads it.

## Request pipeline

1. Fastify assigns a request id (`X-Request-Id`, or a new `req_…`).
2. Helmet sets the security headers. CORS allows only the Studio origin.
3. The Valkey-backed rate limit applies.
4. `StaffGuard` reads the Better Auth session and, for tenant routes, loads the person's grants in
   that tenant (`X-Hamnivo-Tenant`) on every request, so a revocation or suspension takes effect on
   the next request. It then checks the route permission with `@hamnivo/policy`:
   - MFA and a fresh sign-in are required where the catalog says so;
   - `tenantWide` routes need the permission at tenant scope.
5. The handler validates input with the contract schemas from `@hamnivo/contracts`.
6. All tenant data access goes through `withTenant()`, so PostgreSQL row-level security applies.
7. Every change writes a hash-chained audit event in the same transaction.
8. Errors become RFC 9457 problem details (`application/problem+json`) with a stable `code`.
   Malformed or foreign ids are `NOT_FOUND`.

## Conversations (M6 vertical slice)

| Area | Where |
|---|---|
| Chatwoot connection: provisioning, credential registry, staff users | `src/authority/connections.service.ts`, `registry.ts`, `staff-links.service.ts` |
| Webhook intake: signature per source, dedupe across copies, redaction | `src/authority/ingress.*` |
| Worker: webhook events → ledger, publications, journal, Chatwoot-side takeovers | `src/authority/processor.service.ts` |
| Ownership and fencing (epoch, outbox sync to Chatwoot) | `src/authority/ownership.service.ts`, `sync.service.ts` |
| Exactly-once writes through the message ledger | `src/authority/outbound.service.ts` |
| Realtime journal (per-lane gapless sequences, Valkey wake-ups) | `src/authority/journal.service.ts` |
| Widget API: sessions, identity, conversations, SSE, long-poll | `src/widget/*` |
| Staff actions: view, takeover, return to AI, reply and notes as yourself | `src/conversations/*` |
| AI replies with fenced publication, run by the brand's published agent | `src/runtime/replies.service.ts` |

`test/slice.int.test.ts` runs the whole slice over HTTP: the gateway, a hand-driven worker, and
the fake Chatwoot, which calls the gateway's webhook endpoints. It covers:

- the AI reply;
- idempotent sends;
- stream resume;
- takeover while a reply is in flight, and during generation;
- a takeover made inside Chatwoot, caught by the pre-flight check;
- staff replies and private notes;
- handoff;
- identity switch;
- refresh-token reuse;
- cross-tenant denial;
- webhook signatures.

## AI agents (M7)

| Area | Where |
|---|---|
| Agents: drafts, immutable published versions, rollback (G01, A07) | `src/runtime/agents.*` |
| Model credentials: tenant connections or platform keys, revealed just in time; replaced in place and tested with one call | `src/runtime/models.ts`, `model-connections.*` |
| Kill switches for the tenant, a brand or an agent (X08) | `src/runtime/kill-switches.*` |
| Run telemetry: version, model, tokens, time, outcome, hashes only (G12, X11) | `src/runtime/runs.*` |
| Prompt: Hamnivo's rules first, business instructions after, customer view only | `src/runtime/prompt.ts` |
| Honest identity guard in EN, AR, HI, UR, Hinglish and Roman Urdu (U09) | `src/runtime/honesty.ts` |

How a customer message is handled:

1. **The brand's published default agent answers.** Without one, the conversation goes to people
   with an internal note saying why. The same happens when a kill switch covers the brand or the
   agent.
2. **The reply is generated within the agent's limits:** output tokens, time, steps and history
   length. When the model is overloaded or unavailable, the fallback models are tried; they are
   never tried after a bad request.
3. **The honesty guard checks the reply.** A reply that claims to be a person is regenerated once
   with a correction. If the second reply fails too, nothing is published and people take over.
4. **The outbox retries a failing model twice.** After that, the conversation goes to people.
5. **Assist mode never answers customers.** The agent writes a suggestion as an internal note.

`test/agents.int.test.ts` covers these paths over HTTP. A mutation check confirms the tests catch a
missing kill-switch check and a disabled honesty guard.

## Knowledge (M8)

| Area | Where |
|---|---|
| Sources (owner, public or internal, review cycle), documents and versions (G04) | `src/knowledge/knowledge.*` |
| Ingestion (G17): scan, then type check, parse, sanitize, chunk, embed and index | `src/knowledge/ingestion.service.ts`, `extract.ts`, `text.ts`, `scanner.ts` |
| Hybrid retrieval with eligibility filters applied before ranking (G05) | `src/knowledge/retrieval.service.ts` |
| Passages fenced as data; citations checked against what was retrieved (G06, X09) | `src/runtime/prompt.ts`, `replies.service.ts` |

- **Scanning.** ClamAV scans uploads over INSTREAM when `CLAMAV_URL` is set; otherwise only the
  EICAR test file is caught. A scan that cannot run refuses the upload.
- **Parsing limits.**
  - Text must be valid UTF-8.
  - A PDF must really be a PDF, of 500 pages at most (unpdf).
  - A Word file must really be DOCX (mammoth).
  - HTML loses its scripts, styles and navigation, and headings become Markdown.
  - Parsing stops after 30 seconds.
- **Search.**
  - Retrieval fuses vector similarity (pgvector HNSW, cosine) and word matches (`simple`
    tsvector, so Arabic, Urdu, Hindi and English all work) by reciprocal rank.
  - Only the current ready version of an active document is eligible. It must also be in an active
    source of the brand, visible to the audience, not expired, and reviewed within its cycle.
- **Sources in answers.**
  - Sources are stored with the publication record.
  - The widget shows them from there, matched by message ID, never from content in Chatwoot.
  - The agent's display name comes from the same record.

`test/knowledge.int.test.ts` covers ingestion of Markdown, HTML and PDF, refusals, version
replacement, visibility and freshness rules, Urdu and Hindi search, cited answers and tenant
isolation. `test/knowledge.test.ts` covers the parsers, the ClamAV client, chunking and citations.

## Customer memory (release L)

| Area | Where |
|---|---|
| Extraction after each customer message: the model proposes, the write policy decides (L07) | `src/memory/extraction.service.ts`, `writer.service.ts` |
| Customer controls in the widget: see, agree, correct, confirm, delete, forget (L04) | `src/memory/widget-memory.controller.ts`, `customer-memory.service.ts` |
| Studio: provenance, history, review, correct, outdated, delete, erase, export (L04) | `src/memory/admin-memory.controller.ts`, `admin-memory.service.ts` |
| Deletion receipts, tombstones, citation scrubbing, retention and replay (L05) | `src/memory/deletion.service.ts`, `fingerprints.ts` |
| Recall in replies within the agent's budget, cited as memories (G19) | `src/memory/recall.service.ts`, `prompt.ts`, `src/runtime/replies.service.ts` |
| Per-customer memory version and cache namespace (K09) | `src/memory/cache.ts` |

- **Off until both agree.** Nothing runs unless the brand's agent has `memory.enabled` and the
  customer agreed (`POST /v1/widget/memory/consent`, stored in `learning_consents`). Only
  messages written after the agreement reach a model for memory, and a job proposes only from the
  message that started it (earlier ones are context).
- **The policy decides.** `evaluateMemoryWrite` (`@hamnivo/domain`) sets every field of a record
  and explains each decision without content. A value that disagrees with the current one waits
  for review; neither is used in replies until the customer or staff confirm.
- **Staff permissions.** `memory.read` to see, `memory.manage` to correct, confirm, reject or mark
  outdated, `memory.delete`, `memory.erase` and `memory.export` (both need a recent sign-in), all
  checked for the customer's brand and audited with keys and codes only.
- **Deleting.** In one transaction: a receipt, content-free tombstones (HMAC fingerprints keyed
  from the KEK), the records and their vectors, and the memory parts of published answers and
  the realtime journal. The worker then purges the customer's cache namespace, checks that
  nothing the tombstones cover is left and completes the receipt. Chat history in Chatwoot stays.
- **Maintenance.** Hourly, memory past its retention is deleted the same way; daily, tombstones
  are replayed (`app.apply_memory_tombstones()`), as after a restore. Recall also skips any row a
  tombstone covers.
- **Never cached, never logged.** Recall reads the database for every reply. Runs record counts,
  a snapshot hash and that the reply may not enter a shared cache. Memory endpoints send
  `Cache-Control: no-store`, and logs carry counts only.

`test/memory.int.test.ts` covers consent, the refusals, corrections and review, deletion with its
receipt, replayed jobs, erasure, retention, restores, access between customers, tenants and staff
roles, recall in replies and the audit log.

## Reconciler (M10)

Chatwoot does not retry most webhooks, so webhooks only make Hamnivo fast. The worker's
reconciler makes it complete:

- **What it follows.** Each conversation is followed from its first message. A maintenance job
  every ten minutes picks up any conversation without a cursor (`app.ensure_reconcile_cursors()`).
- **Each poll.** It reads the conversation's state and the messages after the last one it saw,
  then applies them through the same processor as webhooks.
- **Idempotent.** A message seen by both paths is journaled once. A staff reply acts as a takeover
  only on its first sighting, so a replay never takes a conversation back from the AI.
- **Timing.** Polls come 15 s after news, then back off to 1 minute (AI or waiting), 2 minutes
  (a person), 10 minutes (snoozed) or 1 hour (resolved). A resolved conversation is dropped after
  a week without activity.
- **Cross-tenant leasing.** Cursors are leased across tenants by `app.claim_reconcile_cursors()`.
  Suspended tenants and disabled connections are skipped.

Late publication (R06):

- **Fences.** An AI reply is fenced when it is reserved, by the Chatwoot pre-flight check, and
  again against Hamnivo's own ownership right before it is posted. That last check catches a
  takeover that has not reached Chatwoot yet.
- **Detection.** A reply that still races a takeover while it is being posted stays visible,
  because nothing is deleted. It is marked `late_publication` and audited
  (`conversation.late_publication`), and the new owner gets a private note.
- **Conservative timing.** Chatwoot's timestamps have one-second resolution, so a reply stored
  within a second before the takeover is also reported.

## Customer flows (M11)

- **Identity keys** (`/v1/admin/brands/{brandId}/identity-keys`). Brands register the keys that
  verify their customers' identity assertions: an ES256, EdDSA or RS256 public key, or an HS256
  secret generated and shown once. Registering needs `widget.identity_keys`, two-step
  verification and a recent sign-in. A key can be retired (it still verifies during a rotation)
  or revoked. A revoked key is refused at once, and the chat sessions it signed customers into end
  (`widget_sessions.identity_key_id`). Assertions may be dated up to 5 seconds ahead of this
  server's clock.
- **One reply per burst.** A reply job stops when the customer wrote again meanwhile. It checks
  before and after generation. The newer message's job answers with both messages in view.
- **Feedback and reopen.** `POST …/feedback` stores a rating of a resolved conversation, and staff
  see it as a private note. `POST …/reopen` reopens it without writing. A customer who writes
  again also reopens it, as in Chatwoot.
- **Business hours** (`PUT /v1/admin/brands/{brandId}/business-hours`). These set the widget
  configuration's `availability`, and the answer to "talk to a person": queued, or offline with
  the time people are back. Without hours, the widget never claims someone is available.

## Imports and exports (M01–M08)

Staff bring a company's chat history from another tool into Chatwoot, and export a brand's
history in the same format. Hamnivo keeps only the state of each job; the history itself lives in
Chatwoot.

| Area | Where |
|---|---|
| API under `/v1/admin/migrations`: upload or connect, check again, dry run, start, pause, resume, cancel, retry, roll back, approve, samples, records, export | `src/migration/migration.controller.ts`, `migration.service.ts` |
| Worker: scan, read, plan, import in checkpointed slices, reconcile, roll back, purge | `src/migration/engine.service.ts`, `destination.ts`, `views.ts` |
| Export of a brand's history as a Hamnivo package | `src/migration/export.service.ts` |
| Another Chatwoot as the source (M04), and its address rules (the shared egress guard) | `src/migration/chatwoot-source.ts`, `source-guard.ts` |
| Export formats, the package, planning and reconciliation | `@hamnivo/migration-sdk` |

- **Quarantine first.** An upload (tawk.to, Zendesk, Intercom or a Hamnivo package, up to 20 MB)
  is stored in `migration_files`, scanned (a scan that cannot run refuses it) and only then read.
  A Chatwoot source is read once with a token that only the secret broker holds, which is revoked
  right after. Its address must be public `https`, checked again for every connection
  (`MIGRATION_SOURCE_ALLOW_PRIVATE` lifts this for development only).
- **Checked before anything is written.** The preflight lists counts, fields and how each is
  imported, known limits of the source and every record that needs review. It blocks while
  Chatwoot is not connected, while the import inbox has anything that could notify people, while
  an automation or integration would act on imports, or when the file comes from another source.
  The dry run writes nothing.
- **Nothing reaches customers.** Each brand gets its own import inbox: an API inbox without
  webhook, bot, auto-assignment, greeting or surveys. Messages keep their original time
  (`external_created_at`), internal notes stay private, mentions are neutralised, conversations
  are resolved only after their last message, and writes are paced
  (`MIGRATION_MESSAGES_PER_MINUTE`, at most 200 per conversation).
- **People.** Contacts are matched only by a verified identity. Typed-in emails and phone numbers
  are kept as contact attributes and never given to Chatwoot as email or phone.
- **Exactly once.** Every record is keyed by its source ID (`hv1:imp:<job>:<source id>`), scoped to
  the account it came from. A write whose outcome is unknown is looked up before it is repeated.
  Retries are bounded, and a later import skips what an earlier one imported. Jobs run in slices
  (`MIGRATION_SLICE_SECONDS`, `MIGRATION_SLICE_CONVERSATIONS`) that end at a checkpoint, so pause,
  cancel and a crashed worker all continue from there.
- **Reconciliation and cutover.** Every record found is accounted for: imported, skipped,
  quarantined with a reason, or failed. Samples are read back from Chatwoot beside the export. A
  failed check (for example an export that was cut short) must be acknowledged at approval.
  Until then, rollback deletes what the import created, keeping live conversations and people
  that later imports still use. The upload is deleted at approval or rollback, or
  `MIGRATION_EXPORT_RETENTION_DAYS` after the job ends; exported packages after 24 hours.
- **Access.** `migration.review` to see jobs, `migration.run` to upload and run them (starting
  needs a recent sign-in), `migration.manage` to roll back and approve. Every action is checked
  for the job's brand and audited. Logs and audit entries carry IDs, counts, file names and source
  addresses, never message text, personal data or tokens.

`test/migration.int.test.ts` covers the preflight, quarantine and scanning, the dry run, imports
with files, notes and identities, reconciliation, rollback, crashes, pauses, cancellation,
retries, access and the export round trip. `test/migration-chatwoot.int.test.ts` covers another
Chatwoot as the source and the address guard, and `test/migration-helpdesks.int.test.ts` covers
Zendesk and Intercom exports.

## Team routing decisions (J02, J05, J08)

- **Team routing** (`GET /v1/admin/brands/{brandId}/routing/teams`,
  `PUT /v1/admin/brands/{brandId}/routing/teams/{teamId}`): routing uses the inbox's teams
  (`/v1/admin/teams`, in the brand's workspace or tenant-wide) and keeps, per brand, the topics a
  team handles, the languages its people answer in and those served through a reviewed
  translation path, whether it is the default, whether it accepts conversations, and whether
  routing uses it at all. Reading needs `decisions.read`; changing needs `decisions.manage`; every
  change is audited.
- **Rubric** (`/v1/admin/brands/{brandId}/decisions/team-routing`, `…/draft`, `…/publish`,
  `…/mode`, `…/test`): versioned topics with baseline keywords, the inputs shared with the
  provider (recent customer messages with personal data redacted, conversation status), a
  threshold per language slice and the provider (`none`, `mock` or `jev` with a pinned version).
  Changing needs `decisions.manage`; every change is audited.
- **When it runs.** The outbox topic `conversation.route` runs on a conversation's first customer
  message and on every hand-off. Jev decides within the rubric's deadline (1.5 s on the chat path)
  behind the circuit breaker; the deterministic baseline decides when Jev abstains, fails, is
  too slow or is not sure enough for the language. A request for a person is never overridden.
- **Modes.** Brands start in `shadow`: both decisions are recorded, the baseline's is final and no
  team is assigned. `live` puts the conversation in the chosen team's inbox queue the way the
  inbox does (`conversation_inbox_state.team_id`, then `conversation.team_changed` sets the
  Chatwoot team, created on first use), so team queues and team-scoped grants see it. Only
  accepting teams are chosen; a team a person set is kept, and so is a conversation a person
  handles. Routing picks a team, never an owner.
- **Records** (`…/records`, `/v1/admin/decisions/{decisionId}`, `…/review`) keep labels, versions,
  latency and tokens, never customer text; confidence only when the provider gave one.
  `…/experiment` compares Jev with the baseline per language from shadow and live records.

## Reply checks (J03, J04, U01, X10)

Jev checks around an AI reply live in `src/checks/`. `ReplyChecksService.forRun` loads a brand's
check settings once per run and returns one handle (`RunChecks`); the reply path calls it from a
few points: the inbound checks (message guard and escalation, side by side), the language
decider, passage relevance, and the draft checks (answer check and message guard, side by side,
after the receipt check). Each check asks exact questions about a minimized state (personal data
replaced by its kind), and `@hamnivo/domain` decides what the answers mean. A check can only hold
a reply, drop a passage or hand the conversation to people.

- **Settings.** Studio's `/v1/admin/brands/{brandId}/checks` API: a versioned rubric per check with
  thresholds per language, and the mode (`off`, `shadow`, `live`). Brands start in `shadow`.
- **Records.** One `decision_checks` row and one run step per check, with labels, numbers and
  document ids, never text. A run's check writes go one at a time, since run steps are numbered
  in order.
- **Within the run.** A check's deadline is what is left of the agent's time limit, and a draft is
  written again only when half of it is left. When Jev is unavailable, or a language has no
  thresholds, the reply goes on as it would without the check.
- **Someone at risk.** The message guard's urgent result skips memory, cache and model. Hamnivo's
  safety wording (`SAFE_REPLIES`) is fixed text, so the plan's limits and the AI budget never hold
  it back: they only stop replies a model would write (`ai_limit` is decided after text approvals,
  the request for a person and the guard, and with the allowance used up only the guard's safety
  question is asked). While the AI has the conversation, the hand-off to people (with the urgent
  note) and the reservation of the wording commit in one transaction, and the outbox posts the
  wording (`conversation.safe_reply`) at least once, shown once, as the bot that held the
  conversation. It goes out only while the conversation still waits for people at that hand-off's
  epoch and Chatwoot shows no person on it: never over a person.
- **A request for a person, and someone at risk.** The deterministic hand-off comes first, exactly
  as before (J04): no provider is asked before it. Only then the guard's check runs (not the
  escalation advice). Live, if it finds someone at risk, the urgent note is queued and, while
  nobody has answered, the wording follows. Jev can only add; if it is unavailable, or the brand
  has no message guard, the hand-off stands as it is. There is no deterministic detector of
  self-harm or danger to fall back on.
- **The AI cannot answer** (no published agent, assist mode, a kill switch). The hand-off to
  people is committed first and the guard is asked after it, exactly as after a request for a
  person (`guardAfterHandoff`; without an agent the brand name is the display name and the guard's
  own deadline, 1.5 s, applies). A kill switch does not stop the wording: it is fixed text, not
  model output.
- **Conversations people have or wait for** (`WAITING_HUMAN`, `HUMAN_ACTIVE`, `PAUSED`).
  `onCustomerMessage` reads the customer's message for risk before any assist suggestion, in its
  own run (`kind: guard`, trigger `guard:{ledgerId}`), only for a brand that has the message
  guard (checked before the conversation is read), and logs its own failures: it never fails the
  job or holds up the suggestion. The window ends at the job's own message
  (`authorityMessageId`) and no job is skipped for a newer message, so a burst longer than the
  window hides none. Shadow records only. Live, when someone is at risk, who has the conversation
  is read under the control row's lock: with nobody assigned, the urgent note is queued and the
  wording (`SAFE_REPLIES`) is reserved and posted at once; with a person assigned, the note
  carries the staff wording (`SAFE_REPLIES_STAFF`, in the reply language) and a delayed outbox
  event (`conversation.safe_reply_fallback`, `STAFF_FALLBACK_MS`) posts it only if the AI does not
  have the conversation, Chatwoot shows no public outgoing message since the customer's message
  (read right before the post; a reply between the check and the post is an accepted race) and the
  24-hour limit allows it. A wording is posted under a fence kept with its reservation
  (`publishSafeReply`): in `WAITING_HUMAN` or `PAUSED` only while the owner mode and epoch are
  unchanged, never in `AI_ACTIVE` or `HUMAN_ACTIVE`; the fallback instead needs a conversation
  the AI does not have.
- **Limits.** One automatic safety wording per conversation in 24 hours, on every path
  (`conversation_controls.safety_worded_at`), and one urgent note per conversation in 10 minutes
  where people have it (`safety_alerted_at`). Both are read and set under the control row's lock,
  in the transaction that reserves the wording or queues the note. When the wording is held back,
  the hand-off and the note still happen and the note says why.

## Reply language (U01, U07)

- `GET /v1/widget/language` and `POST /v1/widget/language` (widget session): interface locale,
  explicit reply language (`en`, `ar`, `hi`, `ur`, `hi-Latn`, `ur-Latn`), style, and closing the
  language question. POST because the widget's cross-origin surface allows GET and POST only.
- Replies follow the explicit choice, then the words of the latest message, then the interface
  locale. Words that fit Hinglish and Roman Urdu equally keep the language in use, suggest one from
  the locale and ask once. The choice and its source are recorded on the model step. Preferences
  keep choices and detected candidates, never message text.

## Answer cache (K01, K02, K06, K07, K08, K09, K10, K12)

- **Store.** A dedicated Valkey connection with a key prefix (`CACHE_KEY_PREFIX`), a 150 ms
  timeout (`CACHE_TIMEOUT_MS`) and no offline queue, wrapped fail-open: a failure reads as
  unavailable, the cache is skipped for 30 s and work is done fresh.
- **Exact answers.** Only a conversation's first message, public, complete, with no personal data,
  personal context or excluded class is stored. Keys bind tenant, brand, audience, language, model,
  prompt version, dependency versions and a per-tenant HMAC of the question. Hits are rechecked
  against the current knowledge. Off until a brand turns it on.
- **Query embeddings** for knowledge search are cached under the text, model, dimensions and
  preprocessing version, and coalesced per process.
- **Invalidation.** Database triggers bump dependency versions with knowledge, source, agent and
  brand changes; policy changes and `POST …/cache/invalidate` bump the tier. Stale entries are
  reported, then removed.
- **Studio** (`/v1/admin/brands/{brandId}/cache/policy`, `inspect`, `entries`, `impact`,
  `invalidate`, `metrics`): reading needs `knowledge.read`, changing `knowledge.manage`; changes
  are audited. Metrics are counts only; health comes from a live probe of the store.
- **Customer memory (K09, G19).** Memory is recalled before the cache is read. A reply built with
  any memory item passes `personalContext: ['personal_memory']`, so it never enters a shared
  entry; for the opening question it may be kept for that customer alone, under their memory
  namespace (`MemoryCache.namespace()`, `hamnivo:memory:c:{tenant}:{subject}:`) with their memory
  version (`MemoryCache.version()`) in the key. A memory change bumps the version, so their
  entries are no longer reachable; a deletion purges the namespace. The run's `answer_cache` step
  says whether an entry was `shared` or the customer's own (`scope`).
- **Commerce data (K06).** Commerce registers its rule (`commerce.live_data`, deciding with
  `answerCacheDecision()`) in both processes. A reply in a conversation that holds catalog, cart,
  quote, payment, order or refund data is neither read from nor written to the cache, and a reply
  whose receipt check read a payment or refund status (X10) is not stored. The run's
  `answer_cache` step names the rule and the data classes.
- **Hooks for other modules.** `CacheExclusions.register(rule)` excludes requests; a module names
  its own data classes (`commerce.order_status`) and its rule decides them.
  `personalContext` on a cache request keeps a result out of shared entries. `PERSONAL_CACHE_SCOPE`
  places private entries (memory provides it; a scope that is missing, slow or not the
  customer's own means the entry is not cached). A store call must match the lookup's audience,
  or nothing is stored.

## Automations (G21, ADR 0011)

`src/automations/`.

- **Editing.** `GET/POST /v1/admin/brands/{id}/automations`, `GET …/automations/options` (the
  brand's tags and teams), `PUT …/automations/prompt-limits`, and `GET/PUT/DELETE
  /v1/admin/automations/{id}`, `POST …/publish`, `PUT …/enabled`, `GET …/versions`, `POST
  …/versions/{n}/restore`, `GET …/runs`. Reading needs `automations.read`, changing
  `automations.manage`. A draft is saved with its revision (a stale one is `VERSION_CONFLICT`);
  publishing checks it with `definitionProblems` from `@hamnivo/domain/automations` and the
  brand's own tags and teams, and keeps an immutable version.
- **Chat rules.** The first customer message, each customer message, a close and a contact form
  message queue `automation.event` when the brand has a published chat rule. `AutomationRunner`
  gathers the facts (latest visit, chat owner, tags, team, hours, who is online), evaluates, and
  runs the actions through the usual paths. A rule acts once per conversation and event
  (`automation_runs`). "Waiting" rules are delayed events that check Chatwoot for anything said
  since the customer's message. Messages are never sent while the AI has the chat (read again
  under the lock), and at most five a day reach a conversation. Runs are kept 90 days
  (`purge-expired`).

## Blocking visitors (H20, ADR 0012)

`src/visitors/blocks*.ts`. `POST /v1/inbox/conversations/{id}/block`, `POST
/v1/visitors/{id}/block`, `GET /v1/visitors/blocks`, `DELETE /v1/visitors/blocks/{id}` under
`visitors.block`. A block names the customer, the browser key and a signed-in account's subject,
never an IP address. `WidgetGuard` refuses chat writes with `CHAT_UNAVAILABLE` (reads, memory,
email choices, read receipts and sign-out stay open); new sessions get `chatAvailable: false`;
the tracker stores nothing for a blocked browser. Blocks are lifted, not deleted, and purged 90
days after they end.

## Channels: email, WhatsApp and Telegram (D13, D14, ADR 0013)

`src/authority/channel-inboxes.service.ts`, `adopt.ts`, `channel-poll.service.ts`. Discovery
records the account's non-API inboxes as `purpose = 'channel'` (every five minutes through the
`inbox`/`all` cursor, and `POST /v1/admin/brands/{id}/channels/find`). The processor adopts a
conversation without a control row on an active, unpaused channel inbox, never one carrying
`hv_conversation`; the customer is a `channel` principal keyed by address. Each incoming channel
message gets a committed ledger row (`hv1:x:`) and the same outbox events as a widget message.
`ai_answers` (off by default) attaches the bot to the Chatwoot inbox; a bot-owned conversation
without it goes to people (`channel_ai_off`). Each channel inbox's cursor lists its recent
conversations every minute, so lost webhooks are caught. `GET /v1/admin/brands/{id}/channels`
and `PUT /v1/admin/channels/{id}` under `integrations.manage`.

## Customer surface (W02, W05–W07, W09, W17–W19, W22–W25)

`src/widget/surface.*`, `attachments.service.ts`, `messages.service.ts`, `help.service.ts`,
`notifications.service.ts`, `customer-emails.service.ts`, `settings.service.ts`.

- **Brand settings.** `GET/PUT /v1/admin/brands/{id}/widget-settings` (widget.configure): layout,
  files, help suggestions and search, the deletion window and email offers.
  Website prompts are automations (G21, below); the brand keeps only their limits. Each change
  is audited and publishes a new configuration version.
- **Launcher.** `GET /v1/widget/launcher?widgetId=` gives the loader the layout, colours, labels
  and the published website automations in one language. The gateway checks what it knows
  (country from `CF-IPCountry`, never stored; language; hours; who is online) and hands the loader
  only the page, referrer, visits and device conditions. The response is `private`, never a shared
  cache. Only the brand's allowed websites get CORS permission to read it.
- **Files.** `POST /v1/widget/conversations/{id}/uploads?name=` takes the file's own bytes
  (`application/octet-stream`, 10 MB at most). The type is read from the bytes; the brand's types,
  size and count apply; the scanner must pass it (ClamAV with `CLAMAV_URL`, the EICAR check in
  development and tests). A scanner that fails, throws or takes over 30 seconds refuses the file.
  Scanned files wait in quarantine for 24 hours and go to Chatwoot with one message only; a retry
  of that message may claim them again. `GET …/attachments/{id}` serves a file only from the
  caller's conversation and the customer's view of it (never a private note's), scanned again,
  as a download with `nosniff` and a sandboxing CSP. In production without `CLAMAV_URL` the
  widget offers no files. Bytes still in quarantine are dropped after a day by the `purge-expired`
  job.
- **Read state.** `POST …/read` moves the customer's read point (unread counts) and tells
  Chatwoot the contact saw the conversation. Chatwoot's `agent_last_seen_at`, read by webhooks and
  the reconciler, marks the customer's earlier messages read (`delivery.updated`, once).
- **Deleting and reacting.** `POST …/messages/{id}/delete` deletes the customer's own message
  within the brand's window (`DELETE_WINDOW_CLOSED` after it, `CAPABILITY_UNSUPPORTED` where the
  authority cannot). Chatwoot keeps a marker; the journal's copies lose their text and the lane
  gets one `message.redacted`. `POST …/reactions` sends a reaction as a short message quoting the
  reply (`in_reply_to`), once, and asks nobody to answer it.
- **Help.** `GET /v1/widget/help/search?q=` searches the brand's public knowledge with the
  assistant's retrieval (20 searches a minute per session).
- **Sessions.** Signing in as someone else or out ends the old session's open streams at once
  (a Valkey signal), not at the next heartbeat.
- **Emails.** `GET/POST /v1/widget/notifications`: verified customers with a verified address
  choose transcripts and reply-waiting emails. The worker sends them through the mailer: a
  transcript when the conversation closes (the customer's view only), and a note when a reply
  stays unread for `CUSTOMER_REPLY_EMAIL_DELAY_SECONDS` (default 300), at most one every 30
  minutes, never with the reply's text. Every email carries a signed one-click unsubscribe link
  (`/v1/notifications/unsubscribe`, RFC 8058) that asks before changing anything.

## Setting up from Studio (A01, A05, A06, G02, W03)

What a business owner needs to set Hamnivo up without help. `src/runtime/model-connections.*`,
`src/widget/appearance*`, `src/setup/*`; the tables are in `packages/db/src/schema/setup.ts`.

- **AI keys.** `POST /v1/admin/model-connections/{id}/test` makes one real call of a few tokens with
  the connection's key (integrations.manage), through the egress guard, with a 10 second limit, and
  answers `ok`, `wrong_key`, `no_credit`, `model_not_found`, `network`, `blocked`, `rate_limited`,
  `unavailable` or `unknown`, with a plain message. Neither the key nor the provider's own text is
  in the answer or the audit entry. The last test of each connection is kept
  (`model_connection_tests`) and shown by `GET /v1/admin/model-connections/status`, which also says
  (yes or no, never a value) which provider keys the server holds, whether Jev is set up and what
  searches the knowledge. `POST …/{id}/rotate` puts a new key in an existing connection: the old
  key is revoked and agents that use the connection carry on. All of these need
  `integrations.manage`, which asks for a recent sign-in.
- **How a brand's chat looks.** `GET/PUT /v1/admin/brands/{id}/appearance` (widget.configure): the
  main colour, logo address, corner radius, greeting, offline text, rating on or off and privacy
  address. The colour is checked with the brand package's `validateTheme`: the text on it must be
  readable and it must show on a white page, else the answer is a 422 saying why. Each save
  publishes a new configuration version. The widget configuration carries the colour, the colour
  of text on it (`onAccent`), the radius, the logo and the privacy address, and `{when}` in the
  offline text becomes the time people are back, in the customer's language and the brand's time
  zone.
- **Test chat.** `POST /v1/widget/sessions` takes `test: true`. Studio's own page
  (`PUBLIC_CONSOLE_ORIGIN`) is allowed to frame the chat and to open a session for a brand for that
  and nothing else; any other website still needs the brand's allowed list. The conversations such
  a session starts are recorded in `test_conversations`: analytics and the inbox counts leave them
  out (the inbox list still shows them), and they use the plan like any other chat.
- **Guided setup.** `GET/PUT /v1/admin/onboarding` (brands.manage): which of the seven steps are
  done or skipped, the brand being set up and whether the guide was finished.

## Widget framing

`GET /v1/widget/frame-policy?widgetId=wid_…` names the websites that may frame a brand's widget
(its allowed websites, or local pages while none are set), in the body and in the
`X-Hamnivo-Frame-Ancestors` header. It returns 404 for unknown or disabled widgets. The production
web server asks it for every widget page and sends the answer as CSP `frame-ancestors`
(`deploy/production/Caddyfile`), so other websites cannot embed a brand's chat.

`PATCH /v1/admin/brands/{brandId}` (brands.manage) renames a brand or replaces its allowed
websites. A website taken off the list stops working at once:
- it gets no frame permission;
- new chats from it are refused (`ORIGIN_NOT_ALLOWED`);
- chats already open there end, because their sessions are revoked and cannot be refreshed.

The audit entry `brand.updated` records the websites added and removed and how many chats ended.

## Commerce (wave Q)

Customers buy in the chat and pay on the provider's hosted page (Stripe Checkout). Chatwoot stays
the conversation authority; everything about money is a Hamnivo record.

| Area | Where |
|---|---|
| Merchant connections: provider, currencies, refund policy, capability manifest (C01, E02) | `src/commerce/merchants.service.ts`, `providers.service.ts` |
| Catalog, versioned cart, exact quote priced live by the provider (C02, C03) | `src/commerce/carts.service.ts` |
| Approval bound to the quote hash and cart revision, hosted checkout (C04, C05) | `src/commerce/checkout.service.ts` |
| Provider answers applied through the state machines: payment, order, cart, quote (C06, C10) | `src/commerce/purchases.service.ts` |
| Operation ledger and receipts: one business key, one idempotency key (C07) | `src/commerce/ledger.ts`, `packages/db/src/schema/operations.ts` |
| Webhooks: raw-body signature, account check, stored once, applied by the worker (C08) | `src/commerce/webhooks.*`, `worker.service.ts` |
| Reconciliation of unknown outcomes and payment checks (C09, R07) | `checkout.service.ts`, `refunds.service.ts`, `worker.service.ts` |
| Orders, fulfilment, refunds with a second approver, finance exceptions (C10, C12, C19) | `orders.service.ts`, `refunds.service.ts`, `exceptions*.ts` |
| Cards in the conversation (catalog, quote, receipt, order status) | `cards.ts`, `card-publisher.service.ts` |
| No payment claim without a receipt (X10) | `claims.ts`, used by `src/runtime/replies.service.ts` |

The rules:

- **Merchant secrets.** A brand's API key and webhook secret are stored only in the secret broker.
  Responses show them masked; they never reach logs, audit data or the browser. Connecting and
  rotating keys need `commerce.merchants.manage`, two-step verification and a recent sign-in.
- **Exact money.** Amounts are integer minor units (`bigint`). A quote is priced by the provider
  at the time it is made, and the customer approves its canonical hash (RFC 8785, SHA-256). A
  changed cart, another hash or an expired quote is refused.
- **Never twice.** Each provider call is an operation with a durable business key
  (`checkout:{purchase}`, `refund:{refund}`) and one idempotency key, and the exact request is
  stored. A call whose answer was lost is `unknown` until the provider is asked by its reference.
  It is sent again under the same key only while the provider still remembers the key (refunds:
  under 23 hours; checkout: while the page would stay open 31 minutes or more). After that, a
  finance exception asks a person.
- **Only the provider says "paid".** Payment, refund and order states move only on a provider
  answer, webhook or check, and each observation is an append-only receipt. The customer sees
  "confirming" until then, and the AI may not say "paid" or "refunded" without a receipt.
- **Takeover.** Whenever a person becomes the owner (a takeover, an inbox claim, a supervisor's
  assignment, an assignment or reply in Chatwoot), a private note lists the payments and refunds
  still owed an outcome. It comes from `OwnershipService.transition`, which every path uses. The
  worker keeps checking them whoever owns the conversation.
- **Staff actions** use `@hamnivo/policy` (`commerce.read`, `commerce.carts.manage`,
  `commerce.orders.manage`, `commerce.refunds.request`, `commerce.refunds.approve`,
  `commerce.exceptions.resolve`, `commerce.merchants.manage`) and are audited. The person who
  asked for a refund can never approve it.
- **No caching.** Every commerce response is sent with `Cache-Control: no-store`.

Settings: `COMMERCE_PROVIDER_TIMEOUT_MS` (default 10000), `COMMERCE_CHECKOUT_MINUTES` (how long
a payment page stays open, 30 to 1440, default 60), `COMMERCE_ALLOW_MOCK` (in-memory `mock`
merchants outside development, for demos) and `COMMERCE_STRIPE_API_BASE` (tests only: stripe-mock
or the fake Stripe server; refused in production).

`test/commerce.int.test.ts` covers the whole flow with the `mock` provider and, at the end, the
Stripe adapter against the fake Stripe server: quote, approval, payment page, webhook, receipt,
replays, timeouts before and after the provider acted, a bank challenge, refunds with a second
approver, finance exceptions, fulfilment, a takeover with a payment in flight and cross-tenant
denial. Nothing calls the real Stripe API.

## Team, enterprise sign-in and platform operations (A02, A09, A12, A13, A17, A18)

- **Members** (`/v1/admin/members`, `…/{id}`, `…/{id}/offboarding`, `…/{id}/remove`). Change a
  role or scope in one step, suspend, restore and remove, each within the delegation ceiling and
  audited. Suspending or removing ends access in the workspace at once: the next request and the
  next heartbeat of a live stream find no membership. Sign-in sessions end too when no other
  workspace keeps the person (`member.sessions_ended`). Removing revokes every grant, team place
  and pending invitation; `…/offboarding` lists first what the person holds.
- **Invitations** (`/v1/admin/invitations`, `…/{id}/resend`). Resending replaces the secret. A
  suspended member can't be invited back (restore them instead), and accepting needs the invited,
  verified address.
- **Custom roles** (`/v1/admin/roles`, `…/preview`). Built-in roles are read only. Creating and
  editing need `roles.manage` with a fresh sign-in and compare the version edited. The preview
  returns what is added and removed, what needs extra checks, who gains or loses what, and what
  the editor could not grant.
- **Audit log** (`/v1/admin/audit`, `…/verify`, `…/export`). Export streams CSV or NDJSON page by
  page with `audit.export` and a fresh sign-in, and is itself audited. Audit data never holds
  secrets (redacted when written) or customers' messages.
- **Single sign-on** (`/v1/admin/sso`, `…/domains`, `…/domains/{id}/verify`, `…/connections`).
  A workspace proves an email domain with a TXT record at `_hamnivo-verification.<domain>`
  (`node:dns`, or `SSO_DNS_SERVERS`). Only one workspace can hold a domain verified, whatever
  another one publishes. A verified domain gets one OpenID Connect connection, found by discovery;
  the issuer must use HTTPS on a public address unless its origin is in
  `SSO_TRUSTED_IDP_ORIGINS`. The client secret lives only in the secret broker. A connection can
  require SSO for its domain (password and passkey sign-ins are then refused with `SSO_REQUIRED`)
  and name the role for just-in-time members; roles with actions that need two-step verification
  can't be named. Changes need `security.manage` (two-step verification, fresh sign-in).
- **Signing in with SSO** (`POST /api/auth/sign-in/sso`, `GET /api/auth/sso/callback/{id}`; every
  other path of the SSO plugin is closed). For each request, `SsoRuntime` loads the one connection
  concerned through the pre-tenant resolvers and hands it to Better Auth with its secret. An SSO
  identity is joined to an existing account only when the provider asserts the address as
  verified and the account's address is verified too; otherwise sign-in fails with
  `sso_email_unverified` or `sso_unverified_local_account`. New people join with the chosen role
  (`member.joined_by_sso`). The callback carries no opener policy, so a sign-in in a small window
  can report back to the page that opened it. The addresses of a connection (issuer and endpoints)
  are checked with the egress guard (`@hamnivo/adapters/net`) when it is saved. The plugin itself
  then calls the token, key and user-info endpoints with the global `fetch`: `SSOOptions` has no
  option for another one, so those calls are not behind the guard's connection check. The plugin
  refuses redirects and private addresses on its own, with a single lookup it does not pin to the
  connection. Closing that gap takes a `fetch` or `dispatcher` option in the plugin (or a patch of
  it), or running the code exchange here; replacing the global `fetch` would reach every other
  request the process makes (X05 in `docs/status/evidence.json`).
- **Support access** (A18). Platform operators ask (`POST /v1/platform/support-grants`) with a
  reason, scopes (`configuration`, `conversations` with status only, `audit`) and a duration. An
  owner with `support.grant` (two-step verification, fresh sign-in) approves it, possibly
  narrower and shorter, declines it or revokes it (`/v1/admin/support-grants/…`). Access is read
  only, ends on expiry or revocation, and every step and every read is recorded in the
  workspace's audit log and the platform's. `/v1/workspace/notices` gives Studio's banners.
- **Platform console** (A17, `/v1/platform/*`). For operators named by the server administrator
  (`main.operator.ts`), with platform roles that no workspace grant can hold. It reads through the
  `hamnivo_platform` database role: workspaces with metadata only, service health, AI stops,
  support access and incidents, whose banners reach every workspace. Without
  `DATABASE_PLATFORM_URL` there is no platform console.

`test/team-access.int.test.ts`, `test/sso.int.test.ts` and `test/platform-support.int.test.ts`
cover these, including cross-tenant denial, the delegation ceiling, domain takeover attempts,
revocation during a session and support access that expires, against a real OpenID Connect
provider in process (`oidc-provider`).

## Security rules enforced here

- **Delegation ceiling (A03).** Grants and invitations may only hand out permissions the grantor
  holds, inside their own scope, and must expire no later than the grantor's own access. Custom roles
  may only contain permissions the editor holds tenant-wide.
- **Owners are protected.** The last owner cannot be revoked or suspended, and nobody can change
  their own access.
- **Credentials are write-only (A06, X04).** Secrets are envelope-encrypted with AES-256-GCM, bound
  to their tenant and row, and never returned or logged. Key-encryption-key rotation rewraps secrets
  lazily.
- **Invitations need a verified email.** The link carries a one-time secret compared in constant
  time, and the invitation must be accepted by the invited email address after server-side
  verification.
- **Idempotency.** `Idempotency-Key` replays the first response and refuses reuse with a different
  body (`IDEMPOTENCY_CONFLICT`). Retried tenant creation reuses a derived tenant id.

## Run

```bash
pnpm --filter @hamnivo/gateway build
pnpm --filter @hamnivo/gateway start:api      # or start:worker; reads ../../.env.local
```

## Test

```bash
pnpm --filter @hamnivo/gateway test           # unit
pnpm --filter @hamnivo/gateway test:int       # PostgreSQL + Valkey (services:up or ci:local)
TYPESAFE_API_KEY=… pnpm --filter @hamnivo/gateway test:live   # opt-in: routing and checks with the real Jev
```

`test:live` is never part of the other runs. Each live file skips itself when its key is not in
the environment, reads the key from there only, and makes a handful of calls.

The integration suites run the real HTTP stack in process (`app.inject`) against a cloned database.
They cover sign-up with email verification, TOTP enrolment and the second-factor sign-in, tenant
creation, invitations, delegation, revocation, step-up, secrets, KEK rotation and the worker.
