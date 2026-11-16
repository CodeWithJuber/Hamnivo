# Hamnivo roadmap: everyday ease, Tawk parity, agentic lead

Written 2026-11-05 on branch `widget/handoff-cancel`. It compares the product with Tawk.to's
features as published on 2026-11-05 (tawk.to/features, /add-ons, developer.tawk.to). Statuses
come from [`feature-status.md`](feature-status.md) and the code. Effort: S ≤ 1 day, M ≤ 1 week,
L > 1 week.

## Advanced chat (started 2026-11-16, branch `ccr-cc8a8908-q5anbo`)

The owner's ask: the customer chat should feel as finished as the chats people know from
Claude or Hostinger, and work on every kind of website. Four phases, each pushed when done.

| Phase | What | Status |
|---|---|---|
| 1 | **The chat itself** (`apps/widget`): look, home, thread, a reply on its way, rich answers, message actions, message box, pictures | Done, see below |
| 2 | **Launcher and every website** (`packages/widget-loader`): launcher in a shadow root, animation, the website's light or dark theme passed to the chat, single-page sites, phones, options by attribute, the direct-link and font routes in Caddy | Done, see below |
| 3 | **Live replies** (gateway): the worker starts a reply at once instead of after every other job, metered streaming, `activity` and `message.delta` events, a Stop button, questions to ask next | Done, see below |
| 4 | **Brand controls** (contracts, gateway, Studio): theme, header style, launcher icon and size, offsets | Next |

### Phase 1, done

| What | Where | Checked by |
|---|---|---|
| **A brand-coloured chat.** The header and the greeting carry the brand's colour, as Studio's picture always showed. Light or dark is an explicit choice (`data-theme`): an embedded chat stays light unless told `theme=dark`, and only the chat's own page follows the device. Before, a dark device turned the chat dark with a brand colour that was only checked on white. On the dark chat the colour is lightened until it stands out. | `theme.ts`, `styles.css`, `shell/Header.tsx`, `App.tsx` | `appearance.test.tsx` (contrast in both), live check (dark) |
| **Nothing appears from nowhere.** New messages, menus, chips and the reply sign move a little on the existing motion tokens; nothing moves under reduced motion. The chat shows its shape while it starts instead of "…", and a failed start offers "Try again". | `styles.css`, `shell/Skeleton.tsx` | Browser journeys (reduced motion), layout audit |
| **Home.** Greeting and who can answer in the brand's colour, the last conversation one press away, suggested questions as rows, help search in one field. | `Home.tsx` | `forms.test.tsx`, `unavailable.test.tsx`, journeys |
| **A thread that reads like a conversation.** Pictures beside replies, name and role once per turn (kept for screen readers on every message), a line where a day starts, the time on every message. | `thread/Bubble.tsx`, `thread/model.ts`, `thread/grouping.ts` | `grouping.test.ts`, `thread-model.test.ts`, journeys |
| **A reply on its way.** Three dots as soon as the visitor has written; the box stays open for the next message. With live events: the step in words, then the answer as formatted text marked as still being written, replaced by the published message. Before, the sign was a text line guessed for 60 seconds, and a streamed draft was plain text that the widget never even received (live-only events were dropped). | `useChat.ts`, `run.ts`, `drafts.ts`, `thread/Thinking.tsx`, `thread/Draft.tsx` | `run.test.ts`, `drafts.test.ts`, live check |
| **Rich answers.** Headings, tables that scroll in their own frame, code with its language and a copy button, `[n]` linked to the nth source, sources as chips with excerpt and freshness, questions to ask next, `choices` cards as buttons. | `markdown.ts`, `thread/Markdown.tsx`, `thread/Sources.tsx`, `commerce/Cards.tsx` | `markdown.test.ts` (7 cases in jsdom), layout audit (long answer) |
| **What to do with a reply.** Copy, Helpful, Not helpful and more reactions under each reply; the reaction shows as a badge on the reply. | `thread/Toolbar.tsx` | `surface.spec.ts` |
| **The message box.** One rounded field with attach, emoji and a round send button; 16 px text (no zoom on iPhones); files by drop and paste; files come back when a send fails. | `composer/` | `composer.spec.ts`, `surface.spec.ts`, live check |
| **Pictures open larger** in the chat; Escape closes the picture, then the chat. | `Lightbox.tsx`, `Parts.tsx` | `surface.spec.ts` with axe |
| **A lighter first load.** Screens a visitor may never open (memory, settings, conversations, forms, cards, emoji, lightbox) load when asked for; bubbles are not redrawn when a reply arrives. | `Chat.tsx` | Build: main script 400 → 344 kB gzip |

**Phase 1 results on 2026-11-16** (Linux container, PostgreSQL 16 with pgvector and Redis installed
natively, `HAMNIVO_SERVICES=native`).

- Widget unit tests: 97 of 97 (70 before).
- Layout audit: 300 of 300 cases clean. Before: 233 of 260, the rest a message area under
  160 px on phones held sideways. 40 of the cases are new: a long answer in the bubble and on
  the full page.
- `CHECK=live` and `CHECK=api` pass.
- Widget `test:e2e`: 48 of 48, with two journeys extended (picture opened larger, Helpful).
- Not run: the gateway's integration suite and Studio's e2e (no gateway or Studio code changed),
  and nothing on a real iPhone or in Safari.

**Found by the new tests and fixed.** Table cells lost their alignment (the sanitizer treated
`align` as an address), and `[1]` never became a link because identifiers were isolated first.

**Not there yet, said plainly.**

- The gateway does not stream: today the dots show until the whole reply arrives (phase 3).
  Stop, the steps in words and the draft only show against the mocked gateway of the live check.
- The loader does not pass the website's theme yet, so an embedded chat is always light
  (phase 2), and a brand cannot choose a theme or a plain header in Studio (phase 4).
- No producer for `suggestions` or `choices` parts yet (phase 3 for the first).
- Translations of the new strings (Arabic, Hindi, Urdu) await native review, like the rest.

### Phase 2, done

| What | Where | Checked by |
|---|---|---|
| **A website's styles cannot bend the chat.** The launcher, its count and the prompts live in a shadow root; the root and the frame start from `all: initial` and hold their place with `!important`. A page that styles every `button`, `div`, `svg` and `iframe` changes nothing. | `widget-loader/src/loader.ts` | `CHECK=sites` (hostile CSS) |
| **Strict security rules need no exception.** Styling goes through the CSSOM and the launcher's picture is built with DOM calls, so a Content-Security-Policy without `'unsafe-inline'` and with Trusted Types works. Before, the picture was set with `innerHTML`, which Trusted Types refuse. | `loader.ts` | `CHECK=sites` (strict CSP, no violation reported) |
| **Light or dark, as the website is.** The page's painted background, then its declared colour scheme; never the device alone. The chat follows when the page changes. `data-theme` decides it instead. | `widget-loader/src/theme.ts`, `contracts/src/bridge.ts` (`env`), widget `App.tsx` | `theme.test.ts`, `CHECK=sites` (dark page, then light) |
| **Single-page apps and tag managers.** A new address is a new page view for prompts and `data-hide-on`; a replaced `<body>` gets the launcher back; a missing `currentScript` is found by its widget ID; a second copy says so and does nothing. | `loader.ts`, `widget-loader/src/pages.ts` | `theme.test.ts` (paths), `CHECK=sites` (SPA) |
| **Options without Studio.** `data-offset-x/y`, `data-size`, `data-icon`, `data-z-index`, `data-hide-on`, `data-hide-on-mobile`; the same as props in `@hamnivo/react` and `@hamnivo/vue`. | `loader.ts`, `placement.ts`, `react/vue src/embed.ts` | `placement.test.ts`, `CHECK=sites` (options), the wrappers' docs tests |
| **A larger chat on request.** "Make the chat larger" in the header asks the loader (`resize`), which grows the floating chat to 720 × 920 px. | `placement.ts`, widget `App.tsx`, `shell/Header.tsx` | `placement.test.ts`, `CHECK=sites` |
| **It feels alive, and calm when asked.** Launcher entrance, hover lift, chat↔cross icon, count pop, prompt slide-in, frame rise; nothing moves under reduced motion. | `loader.ts` | Screenshots |
| **Phones.** The launcher steps away under a full-screen chat and gets focus back; the page is held at its root and body; the screen's bottom edge is measured on the page for the chat. | `loader.ts` | `CHECK=sites` (phone), layout audit |
| **Replies follow the visitor.** A visitor in a conversation gets the chat loaded quietly on the next page, so the count and preview work there; a first visit still loads only `loader.js`. | `loader.ts` | `CHECK=sites` (return visit), `journey.spec.ts` |
| **No launcher where the brand did not allow the website.** The gateway's refusal is readable by that page, so the loader shows nothing and the console says why. | `gateway/src/widget/surface.controller.ts`, `loader.ts` | `customer-surface.int.test.ts`, `CHECK=sites` |
| **Two production fixes.** The direct chat link `/c/<id>` was routed in Studio's host block, so on the chat host, where the link points, it found no page. The launcher's fonts had no CORS, so other websites could not use them. | `deploy/production/Caddyfile` | Caddy 2.10 adapts the file and runs `/c/*` before the framed page; both asserted in `production-smoke.ts` (not run here: no Docker) |

**Phase 2 results on 2026-11-16** (same container, PostgreSQL 16 and Redis started again after
a restart of the session's machine).

- Loader: 38 of 38 unit tests (31 before); 8.6 KB gzip (5.7 KB before, budget 10 KB).
- Contracts 42 of 42, `@hamnivo/react` 102 of 102, `@hamnivo/vue` 39 of 39, the GTM example
  47 of 47, widget 97 of 97.
- Gateway: the launcher cases of `customer-surface.int.test.ts` (4 of 4) and of
  `brands.int.test.ts` (3 of 3). The rest of `test:int` was not run: only the launcher route
  changed.
- Layout audit 300 of 300 clean with the new loader; `CHECK=api`, `CHECK=live` and the new
  `CHECK=sites` pass.
- Widget `test:e2e`: 48 of 48. The first full run had one failure that passed 3 of 3 on its
  own: axe measured a receipt card while it was still fading in. The journeys now run as a
  visitor who asked for less motion (`playwright.config.ts`), so audits see what stays on
  screen; the motion is checked by `CHECK=live` and `CHECK=sites`.
- The Caddyfile was adapted with Caddy 2.10.2 to check its routes; it was not served here, and
  the production smoke test (which needs Docker) was not run.
- Not checked: Safari and iOS, and real third-party websites.


### Phase 3, done

| What | Where | Checked by |
|---|---|---|
| **A reply starts at once.** The worker ran every job of every workspace one after another, looking every second: a reply waited behind other replies, ingestions and migrations. It is now a pump with `OUTBOX_CONCURRENCY` slots (4; 1 is the old way): each conversation's jobs stay in order, others run beside them; it renews what it holds, hands back what waits when it stops, and wakes as soon as a change is journaled. | `gateway/src/outbox/relay.service.ts`, `authority/journal.service.ts` | `units.test.ts`, `outbox.int.test.ts` (a slow job holds only its conversation; order kept; woken in under a second) |
| **Streamed calls are metered.** Metering refused `doStream`. It now reserves before the stream and settles from its final usage; a stream that breaks off, is stopped or never reports usage keeps its reservation held and is never retried. | `billing/ai-credits.model.ts` | `ai-credits.test.ts` (5 new cases) |
| **The reply is written live** (`AI_STREAM_REPLIES`, on). Steps (`activity`: run, searching, tool, writing, checking) and the draft's words (`message.delta`) reach the customer's stream, live only. Whole sentences only, and only while they pass the checks that need no lookup; markers left out; status only while a brand's answer check or message guard is live. A draft that will not be the reply is withdrawn (`message.draft_discarded`, journaled). | `runtime/live-reply.ts`, `stream-gate.ts`, `run-signals.ts`, `replies.service.ts`, `widget/events.service.ts` | `live-reply.test.ts` (10), `streaming.int.test.ts` (words before the published reply, live-only, one draft) |
| **Stop.** The customer's Stop asks the run to stop as a person's Cancel does: nothing is posted, the draft goes at once, a second Stop finds nothing. | `widget/conversations.service.ts`, `client.ts` `stopReply`, widget `Composer.tsx` | `streaming.int.test.ts` (Stop, takeover, another visitor refused) |
| **Questions to ask next** (`AI_FOLLOW_UPS`, `help.followUps` per brand, both on). Written by the agent's model after the answer, metered, at most three; added to the answer as a `suggestions` part. | `runtime/follow-ups.service.ts`, `domain/src/follow-ups.ts`, `contracts/src/parts.ts` | `follow-ups.test.ts`, `follow-ups.int.test.ts` (live and in history; once; off per brand) |
| **Fixed on the way: a sign-in could be lost.** A request refused because a sign-in had just ended its session renewed the ended session, failed, and started an anonymous session over the signed-in one; the customer's next messages went to the anonymous visitor. It now waits for the sign-in and uses its session. Found by the browser journey, which failed in 2 of 4 runs with the new widget's timing (the old widget's timing hid it). | `client/src/client.ts` | `client.test.ts` (2 new cases), `journey.spec.ts` 4 of 4 |

**Phase 3 results on 2026-11-16.** Gateway unit 314 of 314; integration 862 of 862 (65 files,
on PostgreSQL 16 and Redis, after every change below); client 37 of 37; domain follow-ups 3 of 3;
contracts 42 of 42 with OpenAPI regenerated; widget unit 97 of 97; widget `test:e2e` 48 of 48
(streaming and follow-ups on, as in production); `CHECK=api`, `live` and `sites` pass.

- The read-receipt journey now waits a second before staff look: Chatwoot keeps whole seconds,
  and a look counts only when it came after the message. Replies are now quick enough that the
  look landed in the message's own second, and the honest rule did not count it.
- Tests written before streaming run with `AI_STREAM_REPLIES` and `AI_FOLLOW_UPS` off
  (`test/harness.ts`); the new tests turn them on. With streaming off nothing live is sent.
- Not done: `message.created` does not name the draft it replaces (the widget drops every draft
  when a reply is published, which is the same while one reply is written at a time); a
  producer for `choices` cards; Studio's switch for follow-ups (phase 4).

## Done in this pass

| What | Where | Checked by |
|---|---|---|
| **Visitors can go back to the assistant.** After asking for a person, a visitor can return to the assistant until someone takes the chat (HNV-10-02). | gateway, contracts, client, widget | 4 integration cases and the browser journey (HNV-10-02) pass. |
| **The chat fits every screen.** Bubble and panel open full screen on screens ≤ 480 px wide or ≤ 520 px tall: phones, phones held sideways, a laptop at 200 % zoom. The page behind holds still. The floating chat grows to 704 px and stays inside the window. An inline chat is never taller than the screen. | `widget-loader/src/placement.ts` | `placement.test.ts` checks every size. Layout audit: before, 0 of 143 cases were clean; after, 246 of 260. The 14 left have a message area under 160 px on a 320 px-tall screen (a small phone held sideways), plus the waiting banner at 640 × 360. |
| **The header is one compact row.** Name, language (globe + code), memory, more and close sit in one row, with the AI notice on one small line below. It was three rows before. | `widget/src/components/Chat.tsx` | Layout audit |
| **Messages are easier to read and act on.** Every message shows a time. "React" became a 32 px icon. "Talk to a person" is a real button, not a 20 px red link. The privacy link is muted. The message box stops growing at 5 lines. On phones under 352 px, Send shows only its icon. | `Chat.tsx`, `MessageActions.tsx`, `PrivacyLink.tsx` | Layout audit |
| **Visitors notice replies.** When a reply arrives while the chat is closed, a preview over the launcher says who replied ("New reply from Aisha"), never what they wrote. The tab title shows the count, e.g. "(1) Shop", and a short sound plays. Visitors can turn the sound off in Settings; a website can turn sound or title alerts off. | `loader.ts`, `App.tsx`, `Settings.tsx` | Browser check (`CHECK=api`) |
| **JS API.** New: `show`, `hide`, `isOpen`, `getState`, `setLocale`, `prefill`, and the `data-hidden` attribute. Events that were declared but never sent now fire: `conversation.started`, `handoff.requested`, `conversation.resolved`, `error`. New events: `handoff.accepted`, `message` (says who replied, never what they wrote). | `loader.ts`, `hostEvents.ts`, `contracts/src/bridge.ts` | `host-events.test.ts`, browser check |

**Layout audit.** `CHANNEL=chrome node apps/widget/e2e/layout-audit.ts <dir>`. It needs no
database. It covers 20 screens (from a 280 px Galaxy Fold to 2560 × 1440, including phones held
sideways and 200 % zoom), all 4 layouts, and English and Arabic. It checks for horizontal
overflow, controls off screen, tap targets under 24 px, the frame leaving the window, and a
message area that is too small. With `CHECK=api` it runs the browser check of the website API.

**Integration and e2e results.** Run on Colima. Docker Desktop 4.41.2 crashes at start on
this Apple M5 / macOS 27 machine, in `go-m1cpu`.

- **`pnpm test:int`:** gateway 763 of 763, database 248 of 248. The 39 Chatwoot cases skip by
  design because they need a live Chatwoot. This includes the four new handoff-cancel cases.
- **Widget `test:e2e`:** 47 of 48 passed. The one failure was "contact form and tickets", and
  it passed 3 of 3 when run on its own: the ticket's state takes a moment to arrive under full
  load.
- **Studio's e2e suite was not run.** This pass changes no Studio code.

**Fixed on the way.** The widget's e2e stack now gives the gateway the test database for
platform settings (`DATABASE_PLATFORM_URL`), as Studio's stack already did. Before, it used
`.env.local`'s development database and failed whenever that database was empty.

**Seen on the way, not fixed.**

- The loader's `test` script runs `tsdown` with `clean: true`. When it runs alongside turbo's
  `build` (for example in `forge verify`), turbo can cache an empty `dist/`. Every widget e2e
  then fails on a 404 for `loader.js`. Fix: let `test` depend on `build` instead of rebuilding.
- The contact-form ticket test is timing-sensitive.

**Follow-ups from the review of this pass.** None of these blocks a merge.

- Cancelling a handoff on a conversation the AI already closed answers "stays with our team"
  (`conversations.service.ts`, `cancelHandoff`). It should name the closed state; add an
  integration case.
- The widget sets `canReturnToAssistant: true` optimistically for every handoff outcome, so
  "Back to the assistant" can flash after an offline handoff until the server corrects it.
- Releasing the full-screen page lock restores the overflow saved at open. A change the website
  made to `<html>` overflow in the meantime is lost.

## Decisions for the owner

1. **`send-message` from the website.** The contract has had this message since the first
   bridge, but nothing implements it. Sending on a visitor's behalf skips their choice and,
   unless it is routed through the pre-chat form, the brand's consent step too. This pass ships
   `prefill` (it types the words; the visitor sends them). Keep `send-message` unimplemented, or
   allow it only for signed-in customers?
2. **Full-text reply preview.** Tawk shows the reply's words over the closed launcher. Hamnivo
   now shows only who replied, so the conversation stays in the chat's frame, out of reach of
   the website's other scripts. Offer full text as a brand opt-in?
3. **Brand-coloured header.** Tawk, Intercom and Crisp all colour the chat's header. Hamnivo
   kept a white header in this pass because the status and ticket lines in it are only
   contrast-checked on white.

## Phase 1: everyday expectations (next 2 weeks)

| # | Item | Side | Effort | Why |
|---|---|---|---|---|
| 1 | Agents send files and images from Studio's composer | admin | S–M | Screenshots and invoices cannot be sent today. |
| 2 | Transcript by email or download for every visitor | visitor | S–M | Today only verified customers with a verified email get one (W25). |
| 3 | Studio as an installable app (PWA) with push for new chats and approvals | admin | M | There is no mobile app yet, and owners are rarely at a desk (D15). |
| 4 | Round-robin or capacity auto-assignment | admin | M | Manual claiming breaks down at two or more agents (H02 partial). |
| 5 | Hide rules: per page, on mobile, when nobody is online | both | S | Stores hide the chat at checkout. The launcher config has no rules yet. |
| 6 | Emoji picker in the composer; visitor can end the chat | visitor | S | Small, expected polish. |
| 7 | Split the widget bundle: memory, commerce, actions and markdown load on demand | visitor | M | The first open downloads 385 KB gzipped (1.32 MB raw). Target: under 200 KB. |
| 8 | Sneak peek: staff see the visitor's draft live (opt-in, never stored) | admin | S–M | Agents answer faster. Tawk users expect it. |

## Phase 2: developer platform

| # | Item | Effort |
|---|---|---|
| 9 | API-key scopes `conversations.read` (list, read, messages) and `conversations.write` (reply as a named integration). Today keys reach analytics, billing, webhooks and read-only MCP only. | M |
| 10 | `tickets.write` (`POST /v1/tickets`), plus webhooks `ticket.created`, `ticket.updated`, `rating.submitted` and `form.submitted` | M |
| 11 | JS `setContext()` (the `set-context` message exists but is ignored), `track(name, data)` for automations and the timeline, `addTags()` | M |
| 12 | Zapier and Make apps on top of the signed webhooks | M |
| 13 | `contacts.read` and `contacts.write` with a CRM-lite contacts directory in Studio | L |

## Phase 3: agentic features that go beyond Tawk

| # | Idea | Builds on |
|---|---|---|
| 14 | **Knowledge-gap autopilot:** group questions that ended in a handoff, draft an article, approve in one tap | G17, G20, approval cards |
| 15 | **Save as answer:** a person's reply in a takeover becomes knowledge or a saved reply | H05, G04, G10 |
| 16 | **Daily owner brief:** what the AI handled, what needs a person, refunds and revenue, top unanswered questions; by email or WhatsApp | O04, handoff packets |
| 17 | **Approvals on the owner's phone:** refund and discount cards sent to WhatsApp or Telegram | G13, D14 |
| 18 | **AI whisper during a takeover:** next step, policy and order status in the private-notes lane | H03, R04, H11 |
| 19 | **Chat → record:** tags, priority, custom fields and the ticket filled in automatically | H04, H19, G21 |
| 20 | **Plain-language automations:** one sentence becomes a When/If/Then draft with Try-it | G21 |
| 21 | **Workspace doctor:** weekly checks for a widget not on the site, a channel down, stale knowledge or a falling AI answer rate, each with a fix | Home setup, A11 |
| 22 | **Kept promises:** "I'll tell you when it's back in stock", tracked until done | G23, L06, automation outbox |

## Phase 4: rounding out parity

- A public help-centre site on the brand's domain.
- SLA rules (H12).
- Per-agent activity reports.
- Messenger and SMS setup guides.
- Video, voice and screen share (W20, L).

## How each item ships

- Tests with the code: unit tests, plus integration tests for the gateway.
- Docs and `docs/status/evidence.json` updated in the same pass.
- UI changes are checked with the layout audit at all 20 sizes and with the e2e suites before
  merging.
