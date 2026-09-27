# @hamnivo/gateway

The Hamnivo Gateway: one codebase, two processes, both built on NestJS 12 and Fastify 5.

| Process | Entry | Does |
|---|---|---|
| API | `src/main.api.ts` | REST API, staff sign-in at `/api/auth/*` (Better Auth), administration, OpenAPI at `/v1/openapi.json` and `/docs`, health, metrics |
| Worker | `src/main.worker.ts` | Outbox relay (at-least-once), BullMQ maintenance: audit partitions and expiry purge |
| Migrations | `src/main.migrate.ts` | Applies pending database migrations as the schema owner (`DATABASE_OWNER_URL`), then exits |

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
| Model credentials: tenant connections or platform keys, revealed just in time | `src/runtime/models.ts`, `model-connections.*` |
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
```

The integration suites run the real HTTP stack in process (`app.inject`) against a cloned database.
They cover sign-up with email verification, TOTP enrolment and the second-factor sign-in, tenant
creation, invitations, delegation, revocation, step-up, secrets, KEK rotation and the worker.
