# Agency agentic platform: implementation and verification plan

This document tracks the approved scope and the evidence needed before any part is described as
implemented. It is a delivery ledger, not a feature-status declaration. The generated
`docs/feature-status.md` and `docs/status/evidence.json` remain unchanged until their normal
generator has real code and test evidence to read.

## Product decisions

The implementation must preserve these decisions:

- An agency manages isolated client workspaces. A client cannot read another client's data,
  credentials, usage, agents, conversations, or audit records.
- The same product behavior is available in Hamnivo SaaS and self-hosted installations. Hosting
  may change who operates infrastructure, but it must not create a second, reduced product model.
- Model access supports operator-managed credentials and bring-your-own-key (BYOK). Secrets stay
  scoped to their owning workspace or operator boundary and are never returned after creation.
- Agencies can apply their own name, appearance, domain, customer portal, and embedded chat
  widget where the implementation supports them. White-labeling must not weaken origin checks,
  tenant isolation, consent, or audit records.
- WHMCS is the first native billing and provisioning integration. Its lifecycle operations must
  be idempotent and safe to retry.
- Agents can delegate bounded work to other agents through an explicit A2A contract. The local run
  preserves its tenant, conversation, ownership, budget and audit context; an external specialist
  receives only the explicit advisory request and no local grants.
- A refund may be proposed by an agent, but the approved workflow ends in a manual handoff for an
  authorized person to review. No agent may approve its own refund request.
- Existing conversation history is not merged automatically. Any later import or merge must be an
  explicit, reviewable operation with provenance and conflict handling.
- Existing APIs, widget installs, self-hosted deployments, and integrations remain compatible.
  New behavior is additive unless a separately reviewed migration says otherwise.

## Delivery ledger

`Focused verified` means the named implementation suites passed. It does not mean the full repository
pipeline, a browser journey, or a real third-party sandbox has passed.

| Area | State | Evidence and remaining gate |
|---|---|---|
| Agency and client isolation | Verified in focused and full database suites | Contract 3/3, database 4/4 and gateway 3/3 passed. They cover RLS metadata isolation, closed-signup creation, idempotent replay, separate child membership, safe unlink/relink and explicit agency funding. The canonical database suite also passed 20 files/295 tests. |
| SaaS and self-hosted parity | Implemented; release check pending | Agency, branding, usage, connector and workflow routes use the shared gateway and database model. The canonical production deployment smoke test remains required. |
| Managed model access and BYOK | Focused metering verified | Initial AI usage integration 6, unit 7 and playground 3 passed; the corrected cross-feature AI integration selection then passed 88. Managed use reserves neutral credits; BYOK records usage without a managed charge. Real-provider behavior and pricing are not claimed. |
| White-label portal and widget | Focused and browser verified; deployment pending | Branding integration 4, unit 4, domain generator 2 and Caddy 2.11.4 adaptation/validation passed. Five real console/widget Playwright journeys and the final label-focused selector checks passed. Operator DNS/TLS attestation remains. |
| Native WHMCS connector | Focused verified; sandbox pending | Domain 759, connector runtime 24, guarded adapter 14 and live permission-preview 8 passed. The packed 55-test PHP addon suite ran on PHP 8.3 and 7.4, with six expected PHP 7.4 skips. Real WHMCS credentials and the exact API permission response shape remain unverified. |
| A2A communication | Focused verified | Adapter 5 and domain 7 passed for the A2A boundary, untrusted results, invalid responses, timeout, cancellation and finite delegation rules. The corrected external-connection case is also covered by the final workflow integration suite. |
| Agent workflows | Focused verified | The final 14/14 real integration suite covers durable drafts, immutable versions, finite graphs, budgets, runs, approvals, result references, freshness, A2A, recovery and first-reply sequencing. It proves specialist evidence reaches the first coordinator prompt, replay publishes once, and handoff before that reply publishes nothing. |
| Refund handoff | Focused verified | WHMCS runtime tests prove it reads the owned invoice and creates a manual-review packet without calling a refund or mutation API. Final human processing remains outside the connector. |
| Legacy history behavior | Implemented by isolation | Agency creation makes an independent tenant and linking adds directory/funding metadata only. Focused tests prove the parent cannot read child data; no automatic history import or merge path was added. A dedicated legacy-import browser scenario is not part of the focused evidence. |
| Additive compatibility | Internal gates passed | The frozen-source gateway production build, gateway 19 files/297 tests, all 20 project typechecks, lint over 1,898 files and the OpenAPI drift check passed. Canonical database 20 files/295 tests, all package unit scripts, feature-status drift, frozen install, docs/site Astro checks and licence freshness also passed. Console 59 files/738 tests, widget 64, loader 19, their typechecks, the corrected 88-case AI integration selection and the final six browser journeys passed. Production deployment and external-service qualification remain separate gates. |

## Implemented limits

- Managed AI credits are versioned neutral usage units, not currency or provider prices. Unknown or
  partial provider receipts conservatively keep their reservation for later operator reconciliation.
  Tenantless platform embeddings are not metered per tenant.
- Exact response caching, embedding caching and retrieval caching are present. A semantic
  similarity cache for FAQ answers is not implemented.
- Customer email can use the workspace's display name, logo and Reply-To address. The SMTP envelope
  and From address remain the operator's `MAIL_FROM`.
- A custom portal domain becomes active only after DNS ownership verification and exact-host
  operator attestation that routing and public TLS work. The API does not deploy DNS or certify TLS.
  Passkeys and enterprise SSO remain on the canonical portal.

## Verification gates

Use the repository-pinned Node and pnpm versions. At the start of this work the repository declared
Node 22.12 or newer and `pnpm@10.33.0`; record the actual versions beside every result.

### Before review

Run the fast repository checks after all implementation branches have settled:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Run focused tests for each changed package while developing. A file being present or a test being
defined is not evidence; record a passing command and its commit or working-tree state.

### Integration confidence

The canonical local pipeline is:

```bash
pnpm ci:local
```

It installs with the frozen lockfile, runs lint, typecheck and unit tests, validates shell and
deployment scripts, checks generated status and licence files, tests PostgreSQL 16 and 18 with
Valkey, runs the Chatwoot contract suite, audits Storybook accessibility, and runs the widget,
Studio, and website browser journeys. It needs Docker, OpenSSL, and Chromium; shellcheck is used
when installed.

The quick form is useful before review but does not replace the integration run:

```bash
pnpm ci:local --quick
```

The self-hosted CI release-equivalent command adds production deployment and automatic-deploy
smoke tests:

```bash
pnpm ci:local --with-production --with-autodeploy
```

### Real-system verification still required

Repository stand-ins cannot prove compatibility with licensed WHMCS or live model providers. Before
release, run these checks in disposable test accounts and record the product/provider versions,
time, tester, and outcome without copying secrets into this repository.

For WHMCS provisioning, use a development licence and a test product. Install the server module,
configure a test Hamnivo endpoint and test credential, then exercise create, repeated create,
suspend, unsuspend, plan change, invite resend, and terminate. Confirm that retries target the same
client workspace and audit entries name the operation.

Separately test the native customer connector with a least-privilege WHMCS API role and the addon
identity flow. Confirm the real `GetUserPermissions` response has the supported explicit permission
shape, and exercise each enabled read and write against two disposable WHMCS clients. Confirm no
record crosses clients, uncertain writes are not repeated, and refund handoff makes no refund call.

For every supported model provider, use a low-value test credential. Verify an operator-managed key
and a workspace BYOK key independently, then revoke each key and confirm the UI and runtime show a
safe, actionable failure without revealing the credential. Confirm a client cannot select or use a
different client's key.

### Short browser setup for reviewers

1. Start the documented local services, apply migrations, and run the gateway, worker, Studio, and
   widget development servers.
2. Open Studio in Chromium and create an agency plus two disposable client workspaces.
3. Configure one client with managed model access and the other with BYOK. Apply distinct branding
   and domains to both.
4. In separate private windows, open each client portal and widget. Check branding and verify that
   searches, agents, workflows, conversations, usage, and credentials never cross clients.
5. Start an A2A task and a refund request. Follow the activity/audit trail and confirm the refund
   pauses for an authorized person. Do not approve it as the requesting actor.

Exact routes, labels, seed commands, and screenshots belong in the user guides after the matching
code has landed and passed its focused tests.

## Evidence log

Record whether evidence was observed directly in this session or supplied by the responsible
implementation owner. Focused results do not replace the canonical root run.

| Date (UTC) | Revision/state | Command or manual environment | Result | Notes |
|---|---|---|---|---|
| 2026-10-20 | `e3612f5` plus in-progress changes | Toolchain inspection | Resolved | The default shell had pnpm 11.25.0; `corepack pnpm` selected the repository-pinned pnpm 10.33.0 and the frozen install completed |
| 2026-10-20 | Moving working tree | `corepack pnpm lint` | Superseded | The provisional console diagnostics were corrected; canonical lint later passed with one pre-existing channel-health warning |
| 2026-10-20 | Moving working tree | `corepack pnpm typecheck` | Superseded in affected adapter | The reported WHMCS `EgressError` mismatch was corrected. The final frozen-source 20-project typecheck passed |
| 2026-10-20 | Moving working tree | `corepack pnpm test` | Superseded | The missing migration snapshot was corrected; canonical package units and the full database suite later passed |
| 2026-10-20 | Integrated working tree | Agency focused suites (owner-supplied) | Passed | Contracts 3/3, database 4/4 and gateway 3/3; full RLS reached 173/174 before a catalog expectation correction, whose targeted assertion then passed |
| 2026-10-20 | Integrated working tree | Native WHMCS focused suites (owner-supplied) | Passed | Domain 759, runtime 24, adapter 14 and permission preview 8; packed 55-test addon suite exercised PHP 8.3 and 7.4 with six expected 7.4 skips |
| 2026-10-20 | Integrated working tree | Branding/domain focused suites (owner-supplied) | Passed | Integration 4, unit 4, generator 2, Caddy 2.11.4 adaptation/validation and five real console/widget Playwright journeys; live DNS/TLS remains operator-attested and untested |
| 2026-10-20 | Integrated working tree | AI usage focused suites (owner-supplied) | Passed | Integration 6, unit 7 and playground 3; real providers and per-tenant embedding metering remain outside this evidence |
| 2026-10-20 | Integrated working tree | Console/widget suites (owner-supplied) | Passed | Console 59 files/738 tests, widget 64, loader 19, both typechecks and five Playwright journeys passed |
| 2026-10-20 | Integrated working tree | Setup, knowledge and identity regression selection (root-supplied) | Passed | All 45 tests passed. The actions/cache import failures from the same earlier run were superseded by the final actions 21 and cache 19 passing runs |
| 2026-10-20 | Frozen implementation source | Workflow focused suites (owner-supplied) | Passed | Domain 7, adapter 5 and real integration 14/14 include A2A, replay, approval receipts, crash recovery, waits, freshness, local context, first-reply evidence and handoff-before-reply |
| 2026-10-20 | Integrated working tree | Lifecycle compatibility suites (owner-supplied) | Passed | Migration 007, retention, customer privacy and roles: 17 passed, including preservation of unknown-write fences |
| 2026-10-20 | Integrated working tree | Full database suite (root-supplied) | Passed | 20 files/295 tests, including corrected retention and migration/schema parity |
| 2026-10-20 | Integrated working tree | Canonical lint, units and generated status (root-supplied) | Passed | Lint passed with one pre-existing channel-health warning; every package unit script and gateway 19 files/297 tests passed; feature-status drift check passed. Nine optional/live adapter tests were skipped as designed |
| 2026-10-20 | Integrated working tree | Install, docs/site and licence checks (owner-supplied) | Passed | Frozen pnpm 10.33.0 install; docs Astro check and 52-page build; site Astro 35 files with zero diagnostics; licence inventory fresh at 1,105 entries and diff check |
| 2026-10-20 | Frozen implementation source | AI regression selection (root/owner-supplied) | Superseded by passing corrected selection | The first broad selection reached 96/106 and exposed stale expectations plus real quota/HTTP-status bugs. After fixes and expectation alignment, memory 19, agents 14, actions 21, AI credits 6 and playground 28 passed: 88 total |
| 2026-10-20 | Frozen implementation source | Final UI selectors and browser journeys (root-supplied) | Passed | Nine focused selectors and one focused browser journey passed after the final labels. The combined six-journey run passed in 37.3 seconds against the final gateway and worker; named resources and the mobile Arabic live preview were also inspected |
| 2026-10-20 | Frozen implementation source | Final build, units, types, lint and API drift (root-supplied) | Passed | Gateway production build; gateway 19 files/297 tests; all 20 project typechecks; lint over 1,898 files with one pre-existing channel-health warning; and OpenAPI drift check all exited successfully |
| 2026-10-20 | Frozen implementation source | Final agency, branding and retrieval-cache regression (root-supplied) | Passed | Agency 3, branding 4 and retrieval cache 3: 10/10 passed |
