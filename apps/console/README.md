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
the gateway, then set the API to empty. Today this is needed, not only tidy: the gateway's CORS
rules allow GET, POST, PATCH and DELETE but not PUT, and saving an agent draft is a PUT. The
gateway's `PUBLIC_CONSOLE_ORIGIN` must be Studio's origin.

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
- Saving a draft over PUT from another origin (CORS, above).
- Runs can't be filtered by outcome or time on the server. Studio filters the loaded runs by
  outcome.
- A draft has no revision number, so two saves of the same draft version can only be told apart
  by comparing their content. Studio checks for that before saving and publishing.
- Nothing confirms that a website has installed the snippet.
