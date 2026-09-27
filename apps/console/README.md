# Hamnivo Studio (`apps/console`)

Studio is the staff console. It is a static single-page app (Vite, React, TanStack Router and
Query) that talks to the gateway's existing APIs with the signed-in person's cookie.

## What it does today

- **Sign in** (board 02).
  - Email and password.
  - A 6-digit code or a backup code when two-factor authentication is on.
  - Passkeys where the browser supports them.
  - Sign up, "check your email", and forgotten or reset password.
  - When an action needs a recent sign-in, or the session has ended, a dialog asks to sign in
    again over the page. The page keeps its unsaved work, and the action is repeated afterwards.
- **Workspace choice.** Lists the person's workspaces and creates new ones. The choice is
  remembered in this browser. With only one workspace, Studio opens it.
- **Overview.** Brands with their Chatwoot connection, each brand's AI assistant (live version or
  "draft only"), active AI stops, and the latest runs.
- **Brands and install.**
  - Create a brand with its allowed websites, and edit its name and websites later. Studio warns
    that a website taken off the list ends the chats open there.
  - Connect it to Chatwoot.
  - Copy the loader snippet with the brand's widget ID.
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
- **Stop AI.** A "Stop AI" button is always in the header for people who may publish agents. It
  stops AI replies for the whole workspace, one brand or one agent, with a reason. The stops page
  lists active and earlier stops, and lets the AI answer again.
- **Runs.** A table of outcome, version, model, tokens, time taken and start time, with filters.
  A side sheet shows one run's steps. No message text is shown.
- **Account security.** Turn two-factor authentication on or off, and add passkeys.
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

English is the source language. Arabic, Hindi and Urdu are complete but await review by native
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
  - the fake Chatwoot;
  - the built gateway API and worker;
  - the widget and loader (what the snippet points to);
  - Studio's build, with the gateway behind its origin.
- It needs `DATABASE_URL`, `DATABASE_OWNER_URL` and `REDIS_URL` for throwaway services. Never
  point them at data you want to keep. `pnpm ci:local` provides them in containers, and that is
  the easiest way to run the tests.
- Ports: `E2E_STUDIO_API_PORT` (5185), `E2E_STUDIO_PORT` (5186), `E2E_STUDIO_WIDGET_PORT` (5187).
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
  - the inbox (`e2e/inbox.spec.ts`): taking over a customer who asked for a person, replying,
    an internal note the customer never sees, resolving; a colleague's takeover and typing
    arriving live; Arabic; a 390 px phone; keyboard only; an AI suggestion that is not sent;
    offline drafts; filters and a bulk change, with axe along the way;
  - customer memory: review, correct, delete, export and erase, right to left, and access denied;
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
