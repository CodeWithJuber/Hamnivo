# Hamnivo Studio (`apps/console`)

Studio is the staff console. It is a static single-page app (Vite, React, TanStack Router and
Query) that talks to the gateway's existing APIs with the signed-in person's cookie.

## What it does today

- **Sign in** (board 02).
  - Email and password.
  - A 6-digit code or a backup code when two-factor authentication is on.
  - Passkeys where the browser supports them: add them under Account security, then sign in or
    confirm a sensitive action with one.
  - Single sign-on (A13): "Continue with single sign-on" asks for a work email address and goes to
    the workspace's identity provider. When the domain requires it, a password sign-in is turned
    to single sign-on, and errors from the provider are explained on the sign-in page.
  - Sign up, "check your email", and forgotten or reset password.
  - When an action needs a recent sign-in, or the session has ended, a dialog asks to sign in
    again over the page. The page keeps its unsaved work, and the action is repeated afterwards.
    People who signed in with single sign-on are offered it first, in a small window where the
    provider asks who they are again; a passkey works too. Signing in as someone else there
    signs Studio out instead of continuing.
- **Workspace choice.** Lists the person's workspaces and creates new ones. The choice is
  remembered in this browser. With only one workspace, Studio opens it. A workspace that was just
  created opens the guided setup.
- **Guided setup** (`/onboarding`, board 01). Seven steps an owner can do in order, skip, leave and
  come back to: workspace, brand and website, the chat engine (it connects by itself), an AI key
  with a test, a test chat, install (a picker for the website platform, linking its guide) and the
  team. What was done or skipped is kept at the gateway (`/v1/admin/onboarding`). Studio cannot see
  a website, so the install step says it cannot check the code and how to check by hand. The steps
  are in `src/pages/onboarding/`, their logic in `src/lib/onboarding.ts` and `src/lib/install.ts`.
- **Menu** (`src/lib/nav.ts`). Six entries: Home, Inbox, AI assistant, Sales, Reports and Settings.
  Each is a group of pages that already existed, with the permission each page always had.
  - An entry shows when the person can see at least one of its pages, and opens the first one they
    can see. It is active on every page of its group, nested ones such as `/agents/:id` included.
  - When a person can see two or more pages of an entry, they are a row of links above the page
    (`SectionTabs`): the current one has `aria-current="page"`, and on a narrow screen the row
    scrolls sideways.
  - Stop AI is a red button in the header, not an entry. Account security and the Platform
    console are in the account menu.
  - The groups are listed in `docs/using-hamnivo.md`, with what each role sees.
- **Home** (`/overview`). It starts with a block for the person's role, then is the same for
  everyone: brands with their Chatwoot connection, each brand's AI assistant (live version or
  "draft only"), active AI stops, and the latest runs.
  - Someone who does not manage brands (support agents, supervisors) gets **Your chats**: how many
    customers wait for a person and how many chats are assigned to them (the inbox's own counts),
    and an "Open inbox" button.
  - Anyone who can do a setup step gets **Get set up**: the steps still open, in the order to do
    them (add a brand and its website, connect the chat engine, add an AI key, publish an AI agent,
    invite a teammate), each linking to its page, and a button into the guided setup. A step is
    shown only when the person can do it and the lists they can read say whether it is done.
    "Add an AI key" is done by a key of the workspace's own or one the server holds, and "publish
    an AI agent" does not count an agent that answers with the offline practice model. Nothing
    detects the install code on a website, so "add a brand" counts once a brand has an allowed
    website. The list is gone once every step is done.
- **Brands and install.**
  - Create a brand with its allowed websites, and edit its name and websites later. Studio warns
    that a website taken off the list ends the chats open there.
  - Connect it to Chatwoot. The dialog says that Chatwoot is only the chat engine: people work in
    Studio and do not need to open it.
  - Copy the loader snippet with the brand's widget ID.
  - **Look and wording** (W03): the main colour (checked for readable text and shown against a
    white page, with a darker colour to apply when it fails), logo, corner roundness, greeting,
    offline message, rating on or off and privacy link, with a live picture of the chat in each
    language. Nothing reaches customers until it is saved.
  - **Test chat**: the real chat for the brand in a window inside Studio, as a test conversation
    that reports and counts leave out. It needs the chat engine, and the page that serves the chat
    must allow Studio to frame it (`frame-src` in the Studio policy, `deploy/production/Caddyfile`).
  - The brand's business hours in words, with a link to edit them.
- **Business hours** (`/hours`, A05). A brand's time zone, weekly opening times (several on one
  day), quick starts and the days closed, such as public holidays.
- **Support teams** (`/support-teams`). The teams, with people added and taken out one at a time.
- **Customer sign-in** (`/customer-identity`, W12). The keys that verify who a signed-in customer
  is: create (a shared secret is shown once, to copy, or register a public key), replace (a new
  key of the same kind, the old one marked retiring) and revoke.
- **AI keys** (`/models`). Add a key with the provider's models in a dropdown (and the recommended
  one chosen), test it with one tiny real message and read what came back in plain words (wrong
  key, no credit, model not found, no connection), replace it in place, and see which keys the
  server holds and whether Jev is set up (yes or no, never a key).
- **AI agents.**
  - List and create agents.
  - Edit every draft setting: identity, behaviour, model and fallbacks, limits and knowledge.
  - Saving sends the version the page started from. A draft changed by someone else is shown as
    a conflict with the differing fields; nothing is overwritten silently.
  - Publishing asks for a recent sign-in. A banner says that saved is not live.
  - The version list shows each version's state and hash, with rollback.
- **Customer memory** (board 15).
  - Customers with memory or a memory choice, with search, their choice and what waits for review.
  - Per customer: preferences and conversation facts with purpose, source message, who recorded
    them, scope, expiry and history. A newer, different value is shown next to the current one to
    confirm or reject.
  - Correct with a reason, mark outdated, delete (a receipt shows when indexes and caches are
    cleared), erase everything and export, each within the person's permissions.
  - AI agents have a "Customer memory" section to turn memory on and set its limits.
- **Model connections.** List, add (the API key is write-only; only its last characters are shown
  afterwards) and disable.
- **Knowledge.**
  - Sources, public or team-only, with an optional review cycle.
  - Documents with honest states (queued, processing, ready, failed, rejected) and freshness.
  - Add pasted text or Markdown, or a PDF, Word, HTML, Markdown or text file up to 5 MB. The
    size and type are checked before anything is sent.
  - Mark as reviewed, retire, and upload a new version.
  - A search preview shows the passages an answer would use, with their scores.
- **Stop AI.** A red "Stop AI" button is always in the header for people who may publish agents. It
  opens the Stop AI page, where they stop AI replies for the whole
  workspace, one brand or one agent, with a reason. The page lists active and earlier stops, and
  lets the AI answer again.
- **Runs**, called Activity in the menu. A table of outcome, version, model, tokens, time taken and
  start time, with filters. A side sheet shows one run's steps. No message text is shown.
- **Decision rules** (board 12). Routing mode (shadow by default), the inbox's teams with their
  topics, languages and translation languages for the brand (adding a team here creates an inbox
  team in the brand's workspace), the rubric editor (provider and pinned Jev version, time limit,
  topics with keywords, what Jev may see, a threshold per language), a panel to try a message,
  recent decisions with human review, and Jev compared with the fixed rules. Choosing Jev fills in
  the recommended version (`JEV_RECOMMENDED_MODEL`, currently `jev-1.13.0`), and Studio warns when
  the server has no TypeSafe key (`TYPESAFE_API_KEY`), pointing to "Decisions with Jev" in the
  self-hosting guide.
- **Answer caching** (board 25). What is cached per tier and for how long, a question inspector,
  stored answers by fingerprint and sources, stopping reuse after a correction, and use and health
  per day, tier and language. Questions and answers are never listed.
- **Account security.** Turn two-factor authentication on or off, and add passkeys.
- **Team and access** (board 22, `members.read`).
  - Members: role and scope, status and last activity, with search and filters. Invite by email
    with a role and scope (the link is shown once to copy), resend or withdraw invitations, change
    a role or scope in one step, suspend, restore and remove. Studio offers only roles and scopes
    within the person's own reach; the gateway checks the same.
  - Removing someone shows first what they hold (open conversations, which can be reassigned in
    bulk, and their access), and the last owner can't be removed. Nobody changes their own access.
  - Roles: built-in roles are read only. Custom roles are edited by permission area, with what is
    added and removed, what needs extra checks and who gains or loses what, before saving.
  - Audit log: filters by action, actor, target and time, with the outcome of each event, an
    integrity check, and export as CSV or NDJSON of what the filters show (`audit.export`,
    recorded too).
  - Invitations open at `/invitations/accept`, for the invited address only.
- **Security** (`security.manage` or `support.grant`).
  - Single sign-on: prove a domain with a DNS record, connect an OpenID Connect provider (the
    client secret is write-only), turn it on, require it, and choose the role for new people.
  - Support access (A18): requests from Hamnivo's support with reason, scope and duration;
    approve (narrower if needed), decline, and end active access. A banner on every page says when
    support access is active or waiting, and incident banners from the platform show there too.
- **Platform console** (board 26, `/platform`). Only for platform operators, with its own layout:
  workspaces with metadata only (never content), service health, support access requests and
  sessions (reading only what the owner approved), incident banners and the platform audit log.
- **Inbox** (boards 07–10). Staff answer customers here instead of in Chatwoot.
  - Queues: mine, waiting for a person, AI answering, my teams and all, with counts. Filters by
    status, brand, channel, customer language and tag, and search over customers and message
    text. Only conversations the person's grants reach are listed, counted or found.
  - The conversation: customer messages, replies, internal notes (a lock and a dashed border),
    Hamnivo's handoff summaries, sources of AI answers, and translation of a customer message on
    demand, marked as machine translation next to the original.
  - Reply and Internal note are separate lanes with separate drafts. Drafts save to the server
    and stay in the browser while offline. Ctrl+Enter (⌘+Enter) sends; keys pressed while an
    input method is composing are left alone.
  - Take over, assign to a colleague or a team, back to the queue, back to the AI, or ask a
    colleague to hand over. A reply from a view that is out of date is refused and kept as "not
    sent", with a retry that never sends twice.
  - Resolve, reopen and snooze. Saved replies with their variables filled from verified facts
    only. An AI suggestion with its sources, which is never sent on its own.
  - Details: who the customer is and what was verified, tags and custom fields, other
    conversations, linked conversations and, for supervisors, reviews. Bulk changes with a dry
    run and a result per conversation.
  - Live: a colleague's takeover, new messages and "is typing" show up without reloading; while
    the connection is down the inbox says so and checks every 15 seconds.
  - Keys: ↑ ↓ or J K move through the queue, Enter opens, X selects, Esc goes back. On a phone
    the queue, the conversation and the details are steps.
- **Imports** (board 18). Past conversations from tawk.to, Zendesk, Intercom, a Hamnivo package or
  another Chatwoot.
  - Choose the brand and the source. A file's type and size are checked before it is sent, and a
    Chatwoot access token is never shown again.
  - The check lists counts, every field and how it is imported, the source's known limits and the
    records that need review. The dry run shows what would happen, with redacted sample
    conversations, and writes nothing.
  - The import runs in the background with its progress and last checkpoint, and can be paused,
    resumed or cancelled. Records that were not imported are listed with their reason and can be
    downloaded; only failed records are retried.
  - Reconciliation per record type, samples beside the export, a cutover checklist, approval, and
    rollback until then. A brand's history can be exported as a Hamnivo package.
- **Orders** (board 21, `commerce.read`).
  - Orders placed in chat, searchable by reference, with payment and fulfilment side by side and
    what needs attention (refunds waiting, open exceptions).
  - An order page shows items, the payment as the provider confirmed it, fulfilment, refunds,
    every call to the payment provider with its receipts, and exceptions. It is read from the
    records each time and re-checked while something is pending.
  - "Record an update" (`commerce.orders.manage`): in progress, delayed with the shop's estimate,
    shipped with a tracking reference, delivered, active or failed. The customer sees each update
    in the chat.
  - "Request a refund" (`commerce.refunds.request`) reads the amount in any digits and asks when
    it is ambiguous ("1,500"). When the provider refunds only whole payments, the full amount is
    offered instead. Approving (`commerce.refunds.approve`) needs two-step verification and a
    second person: the requester's own buttons are disabled with the reason. A refund shows as
    refunded only after the provider confirms it.
- **Finance exceptions** (`commerce.read`; resolving needs `commerce.exceptions.resolve`). Unknown
  or failed payments and refunds, amount mismatches and orders that could not be updated, each
  with its evidence and the next safe step. "Check with the provider" asks again; "Resolve" needs a
  reason, is audited and moves no money.

Every screen has loading, empty, error and permission-denied states. Status is never shown by
colour alone. Studio works from the keyboard, returns focus after dialogs, and announces results.

## Languages

`pnpm --filter @hamnivo/console test` checks that every locale has every key, the same
placeholders and no empty text. English is the source language. Arabic, Hindi and Urdu are complete but await review by native
speakers; the interface says so in each of them. Arabic and Urdu use right-to-left layout. Pick a
language in the header, or add `?lang=ar` (or `hi`, `ur`) to a link.

## Develop

Run the gateway first (see `docs/self-hosting.md`), then:

```bash
pnpm --filter @hamnivo/console dev       # http://localhost:5173
pnpm --filter @hamnivo/console build     # typecheck, then static files in dist/
pnpm --filter @hamnivo/console preview   # serves dist/ on port 5173
pnpm --filter @hamnivo/console typecheck
```

`routeTree.gen.ts` is generated from `src/routes` on install, typecheck and build. It is not in
git.

`pnpm --filter @hamnivo/console test` runs the unit and component tests in `test/`: text coverage
in every language, who sees which menu entry and setup step, and the menu, the header, Home and the
setup screens rendered to HTML in Node (`test/render.tsx` fills the query cache first, so nothing is
fetched). The files named `flows-*` mount a screen in a DOM (jsdom, `test/dom.tsx`) and type, press
buttons and read back what was sent to the gateway, which `fakeGateway` stands in for. The
browser journeys are in `e2e/`.

Studio takes only the types of `@hamnivo/contracts`, so the schema library stays out of the page.
The few lists it needs as data (the models in the dropdown, the chat's starting words, the steps of
the guided setup) are in `src/lib/setup-data.ts`; `test/setup.test.ts` fails when they differ from
the contracts.

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `VITE_HAMNIVO_API` | `http://localhost:4000` in a build; empty in `dev` | Where the browser sends API requests. Empty means Studio's own origin. |
| `VITE_HAMNIVO_GATEWAY_ORIGIN` | the API base, else `http://localhost:4000` | The gateway address put in the install snippet (`data-api`). |
| `VITE_HAMNIVO_WIDGET_ORIGIN` | `http://localhost:5174` | Where the snippet loads `loader.js` from. |
| `HAMNIVO_GATEWAY_URL` | `http://localhost:4000` | Where `dev` and `preview` pass `/v1` and `/api/auth` on to. |

The `VITE_` settings are fixed when you build. A server can change them without a rebuild by
adding meta tags to `index.html`: `<meta name="hamnivo-api" content="">`,
`hamnivo-gateway-origin` and `hamnivo-widget-origin`.

### Serve Studio on the gateway's origin

Put Studio behind the same origin as the API: serve `dist/` and pass `/v1` and `/api/auth` on to
the gateway, then set the API to empty. Cookies then stay first-party. Studio also works from its
own origin: the gateway allows `PUBLIC_CONSOLE_ORIGIN` for every method Studio uses, so that
setting must be Studio's origin.

## Browser tests (Playwright + axe)

```bash
pnpm build
pnpm --filter @hamnivo/console test:e2e
```

- `e2e/stack.ts` starts everything the tests need:
  - a throwaway database;
  - the fake Chatwoot and the fake Stripe server;
  - an OpenID Connect provider (`e2e/idp.ts`, whose login page takes any password) and a DNS
    server for domain checks (`e2e/dns.ts`);
  - the built gateway API and worker;
  - the widget and loader (what the snippet points to);
  - Studio's build at `http://localhost` (passkeys need a host name), with the gateway behind its
    origin.
- It needs `DATABASE_URL`, `DATABASE_OWNER_URL` and `REDIS_URL` for throwaway services. Never
  point them at data you want to keep. `pnpm ci:local` provides them in containers, and that is
  the easiest way to run the tests.
- Ports: `E2E_STUDIO_API_PORT` (5185), `E2E_STUDIO_PORT` (5186), `E2E_STUDIO_WIDGET_PORT` (5187),
  `E2E_STUDIO_IDP_PORT` (5188) and `E2E_STUDIO_DNS_PORT` (5189).
  `E2E_REUSE_STACK=1` runs against a stack you started yourself with `node e2e/stack.ts`.
- Tests are named after the UX state IDs in `docs/design/UX-State-Matrix.csv`. They cover:
  - sign-up → workspace → brand → Chatwoot → install snippet;
  - "check your email" after a forgotten password;
  - publishing with a fresh sign-in, and keyboard-only save and publish;
  - a draft conflict, and signing in again after the session ended;
  - two-factor sign-in with a code;
  - a write-only model key;
  - a Markdown upload that becomes ready, and a search preview;
  - stopping the AI for a brand, then resuming;
  - runs after a widget conversation, with the run's steps;
  - a routing rubric edited, published and tried in Arabic, with shadow decisions (`e2e/decisions.spec.ts`);
  - answer caching turned on, inspected, reused and stopped in Urdu;
  - the inbox (`e2e/inbox.spec.ts`): taking over a customer who asked for a person, replying,
    an internal note the customer never sees, resolving; a colleague's takeover and typing
    arriving live; Arabic; a 390 px phone; keyboard only; an AI suggestion that is not sent;
    offline drafts; filters and a bulk change, with axe along the way;
  - customer memory: review, correct, delete, export and erase, right to left, and access denied;
  - passkeys (`e2e/passkeys.spec.ts`) with Chromium's virtual authenticator: add one, sign in with
    it, and confirm a sensitive action;
  - single sign-on (`e2e/sso.spec.ts`): a domain proved through DNS, a provider connected and
    turned on, a new person joining with the chosen role, an address the provider never verified
    turned away, a required SSO turning a password sign-in around, and signing in again through
    the provider before an export;
  - team and access (`e2e/team.spec.ts`): an invitation sent and accepted, a role changed, a
    member suspended, restored and removed, a custom role with its diff and impact, and the audit
    log filtered, checked and exported;
  - the platform console (`e2e/platform.spec.ts`): no access for workspace owners, service health,
    support access asked for and approved narrower, and an incident banner;
  - axe (WCAG 2.2 A and AA) on every main screen in English and Arabic;
  - no sideways scrolling from 320 to 1920 px;
  - `e2e/commerce.spec.ts`: a customer pays through the fake Stripe server, one person asks for a
    refund and a second one, with two-step verification, approves it; it shows as refunded only
    after the provider settles it (also in Arabic); a delay recorded with the shop's estimate,
    then shipped (also in Urdu); and a shop that refunds only whole payments.
- The last test saves screenshots for review in `e2e/screenshots/` (not in git).

## Not possible yet

These need gateway changes:

- Allowed websites can't be changed after a brand is created (there is no brand update endpoint).
- Runs can't be filtered by outcome or time on the server. Studio filters the loaded runs by
  outcome.
- A draft has no revision number, so two saves of the same draft version can only be told apart
  by comparing their content. Studio checks for that before saving and publishing.
- Nothing confirms that a website has installed the snippet.

In the inbox, not yet:

- Round-robin routing with capacity checks, SLA deadlines and skill-based routing.
- Conversation summaries and next-step suggestions from the AI; only suggested replies exist.
- Writing a reply in the customer's language with a translation to review before sending.
- Defining tags and custom fields, and editing or deleting saved replies: still done in Chatwoot.
- Merging and splitting conversations: linking is supported instead, and Chatwoot keeps the
  transcripts.
