# Running Hamnivo on your own server

Hamnivo has no hosted CI. You run every check and host every service yourself, with the scripts in
this repository. This guide grows with the product. Each milestone adds its services and steps here.

## What you can run today

| Part | Status | How |
|---|---|---|
| Checks (lint, types, unit, integration on PostgreSQL 16 and 18, Chatwoot contract, accessibility, widget journey in a browser) | ready | `pnpm ci:local` |
| Infrastructure (PostgreSQL 18 + pgvector, Valkey) | ready | `pnpm services:up` |
| Design system (Storybook) | ready | `pnpm --filter @hamnivo/ui storybook` |
| Database schema, row-level security and audit log | ready | `pnpm db:migrate` |
| Gateway API (staff sign-in, tenants, members, roles, grants, secrets, audit) and worker | ready | `pnpm api`, `pnpm worker` |
| Chatwoot CE v4.18.0 (conversation authority) with the Hamnivo Platform App | ready | `pnpm chatwoot:up` |
| Chat API: widget sessions, conversations, live stream, staff takeover | ready | see "Connect a brand to Chatwoot" below |
| Chat widget (Hamnivo Chat), its one-script loader and the JS client SDK | ready (first version) | see "Put the chat on a web page" below |
| Studio, website | not yet built | added by later milestones, with a production compose file and TLS proxy |

## 1. Server requirements

- **OS:** Ubuntu 24.04 LTS or any recent Linux with Docker. macOS works for development.
- **Checks and development:** 2 vCPU, 6 GB RAM, 25 GB free disk. The Chatwoot stage of the checks
  starts a complete Chatwoot (web, background jobs, database) for a few minutes.
- **Full stack in production, later:** 4 vCPU, 8 GB RAM, 40 GB SSD, and a domain name you control.

## 2. One-time setup

```bash
# Docker Engine and the compose plugin (official guide: https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # log out and back in afterwards

# Node.js 24 LTS and pnpm 10
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs openssl git
sudo npm install -g pnpm@10.33.0

# The code
git clone https://github.com/CodeWithJuber/Hamnivo.git
cd Hamnivo
git checkout claude/hamnivo-app-implementation-bhb7rg   # until the work is merged to main
pnpm install

# Browser for the accessibility audit and the widget journey (Chromium and its system libraries)
pnpm --filter @hamnivo/ui exec playwright install --with-deps chromium
```

## 3. Configuration and secrets

```bash
bash scripts/setup/env.sh
```

This creates `.env.local` with generated database passwords, the secret-encryption key and the
auth secret. The script never overwrites existing values, so re-running it after an update is
safe. `.env.local` is gitignored and must never be committed or shared. Back it up somewhere
safe: without it, stored secrets cannot be decrypted.

## 4. Start the infrastructure

```bash
pnpm services:up      # PostgreSQL 18 + pgvector and Valkey, bound to 127.0.0.1 only
pnpm services:down    # stop; data stays in Docker volumes
```

The database creates four roles:

| Role | Purpose |
|---|---|
| `hamnivo_owner` | Runs migrations |
| `hamnivo_app` | Used by the application. It cannot bypass row-level security and owns nothing. |
| `hamnivo_platform` | Platform-console metadata only |
| `hamnivo_resolver` | Owns the few audited cross-tenant functions. It cannot log in. |

To reach the services from another machine, set `HAMNIVO_DB_BIND=0.0.0.0` in `.env.local` and
restrict access with a firewall. For the application alone, keep the default.

### Apply the database schema

```bash
pnpm db:migrate       # idempotent: applies only pending migrations, all-or-nothing
```

Every table has row-level security enabled and forced. The application role only sees the tenant
bound to its current transaction. See `packages/db/README.md` for the details.

### Run the API and the worker

```bash
pnpm api       # builds and starts the gateway on http://localhost:4000 (reads .env.local)
pnpm worker    # outbox relay and scheduled maintenance, in a second terminal
```

- Interactive API reference: `http://localhost:4000/docs`.
- OpenAPI document: `http://localhost:4000/v1/openapi.json`.
- Health checks: `/health/live` and `/health/ready` (database and Valkey).
- Without `SMTP_URL`, verification and invitation emails are printed to the API log, so you can
  open the links directly. On a server, set `SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`).

### Start Chatwoot

Chatwoot CE v4.18.0 owns conversations, messages and private notes. Hamnivo talks to it through its
APIs and signed webhooks (ADR 0001).

```bash
pnpm chatwoot:up      # first run about 2 minutes; http://127.0.0.1:3000
pnpm chatwoot:down    # stop; data stays in Docker volumes (add --volumes to delete it)
```

What `chatwoot:up` does:

1. It starts Chatwoot's own PostgreSQL 16 (with pgvector) and Valkey.
2. It creates or migrates the Chatwoot schema.
3. It starts the web and background-job processes.
4. It creates a super admin and the "Hamnivo" Platform App.
5. It writes the Platform App token to `.env.local` as `CHATWOOT_PLATFORM_TOKEN`.

The super admin email and password are in `.env.local` (`CHATWOOT_ADMIN_*`). Keep the Platform
token secret. Anyone holding it can create accounts and users.

Check the connector against your Chatwoot at any time:

```bash
set -a; . ./.env.local; set +a
pnpm --filter @hamnivo/chatwoot test:int
```

This runs the same contract suite the checks use. Each run creates a small test account in the
Chatwoot you point it at. Chatwoot delivers webhooks to `host.docker.internal`, which is this
machine. For that reason the development stack allows webhooks to private addresses
(`CHATWOOT_ALLOW_PRIVATE_WEBHOOKS=true`). In production the gateway has a public HTTPS address, so
set it to `false` and keep Chatwoot's SSRF protection on.

First steps with the API, before the Studio exists:

```bash
curl -c jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -d '{"name":"Your Name","email":"you@example.com","password":"a long passphrase here"}' \
  http://localhost:4000/api/auth/sign-up/email
# open the verification link printed in the API log, then:
curl -b jar -c jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' \
  -d '{"name":"My Company","slug":"my-company"}' http://localhost:4000/v1/tenants
```

### Connect a brand to Chatwoot and chat through the API

This needs `pnpm chatwoot:up` (it writes `CHATWOOT_URL` and `CHATWOOT_PLATFORM_TOKEN` to
`.env.local`), plus `pnpm api` and `pnpm worker` running. `CHATWOOT_WEBHOOK_BASE_URL` (default
`http://host.docker.internal:4000`) is how Chatwoot's webhooks reach the gateway.

1. Use the tenant ID (`tnt_…`) returned above. Find the workspace, then create a brand with the
   websites allowed to embed its chat:

   ```bash
   T=tnt_...   # your tenant id
   h=(-b jar -H 'origin: http://localhost:5173' -H 'content-type: application/json' -H "x-hamnivo-tenant: $T")
   curl "${h[@]}" http://localhost:4000/v1/admin/workspaces
   curl "${h[@]}" -d '{"workspaceId":"wsp_...","name":"My Shop","allowedOrigins":["http://localhost:8080"]}' \
     http://localhost:4000/v1/admin/brands
   ```

2. Connect the brand. This provisions a Chatwoot account with an HMAC inbox, the AI bot and signed
   webhooks, and stores every credential encrypted:

   ```bash
   curl "${h[@]}" -d '{"brandId":"brd_..."}' http://localhost:4000/v1/admin/authority/connections
   ```

3. Publish the brand's AI agent. Connecting created it as a draft that uses the offline
   `hamnivo-mock` model, and until it is published, people answer every conversation:

   ```bash
   curl "${h[@]}" http://localhost:4000/v1/admin/agents          # note the agent id (agt_…)
   curl "${h[@]}" -d '{}' http://localhost:4000/v1/admin/agents/agt_.../publish
   ```

   To use a real model, save a new draft with a different `model`, then publish again. For example,
   use `{"provider":"anthropic","modelId":"…"}` with `ANTHROPIC_API_KEY` in `.env.local`, or store
   a tenant key first with `POST /v1/admin/model-connections` and reference its `connectionId`.
   Publishing checks that the model has credentials. Every published version stays unchanged, and
   publishing an older version (`{"version":1}`) is the rollback.

4. Chat as a website visitor would. Use the brand's `widgetId`:

   ```bash
   S=$(curl -s -H 'content-type: application/json' \
     -d '{"widgetId":"wid_...","hostOrigin":"http://localhost:8080"}' http://localhost:4000/v1/widget/sessions)
   A=$(echo "$S" | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
   curl -H "authorization: Bearer $A" -H 'content-type: application/json' \
     -d '{"firstMessage":"Assalamu alaikum, where is my order?"}' http://localhost:4000/v1/widget/conversations
   curl -N -H "authorization: Bearer $A" -H 'last-event-id: 0' \
     http://localhost:4000/v1/widget/conversations/conv_.../events
   ```

The stream shows your message and, a moment later, the AI assistant's reply. With the default
agent, the reply comes from the offline `hamnivo-mock` model. The same conversation appears in
Chatwoot (`http://127.0.0.1:3000`), where your staff can also answer. A person replying or taking
over there takes the conversation from the AI.

Each AI reply is recorded as a run: agent version, model, tokens, time and outcome, but no message
text (`GET /v1/admin/runs`). To stop the AI at once, for the whole tenant, one brand or one agent:

```bash
curl "${h[@]}" -d '{"scope":"brand","targetId":"brd_...","reason":"Checking answers"}' \
  http://localhost:4000/v1/admin/kill-switches
```

Conversations the AI held go to people with an internal note, and people keep chatting as usual.
Clearing the switch (`POST /v1/admin/kill-switches/ksw_.../clear`) lets the AI answer again.

### Give the AI your knowledge

1. **Create a source.** Only `public` sources ground answers to customers. An `internal` source is
   for staff and for assist mode.

   ```bash
   curl "${h[@]}" -d '{"brandId":"brd_...","name":"Help centre","reviewEveryDays":90}' \
     http://localhost:4000/v1/admin/knowledge/sources
   ```

2. **Add documents.** Send text for plain text, Markdown or HTML, or `base64` for PDF and Word
   files. Each document can be up to 5 MB.

   ```bash
   curl "${h[@]}" -d '{"title":"Returns","url":"https://shop.example/returns","content":
     {"mediaType":"text/markdown","text":"# Returns\n\nYou can return unworn items within 30 days."}}' \
     http://localhost:4000/v1/admin/knowledge/sources/ksrc_.../documents
   ```

   The worker processes each document in order:
   1. It scans the upload. Malware, or a failure to scan, means refusal.
   2. It checks the file really is the declared type.
   3. It extracts the text, splits it into passages under their headings, and indexes them for
      keyword and vector search.

   A new version of a document replaces the old one only when it is ready.

3. **Connect the knowledge to the agent.** Put the source IDs in the agent's `knowledgeSourceIds`,
   save a draft and publish it. Answers then:
   - cite passages as `[1]`;
   - list the sources under the message in the chat;
   - drop any citation that matches nothing retrieved.

   Documents stop grounding answers when they are retired, past `validUntil`, or not reviewed
   within their source's cycle (`POST /v1/admin/knowledge/documents/doc_.../review`).

To preview what an answer would use, send `POST /v1/admin/knowledge/search` with
`{"query":"…","brandId":"brd_…"}`.

On a server, run ClamAV and set `CLAMAV_URL=tcp://clamav:3310`. Without it, uploads are checked only
for the EICAR test file. `EMBEDDING_PROVIDER` selects the embedding model; the default offline
`mock` matches shared words only, so use a real provider for meaning-based search.

### Put the chat on a web page

The widget is a static app, and the loader is one small script served next to it.

1. Build them and serve them from one origin:

   ```bash
   pnpm build
   cp packages/widget-loader/dist/loader.js apps/widget/dist/
   pnpm --filter @hamnivo/widget preview    # serves apps/widget/dist on http://localhost:5174
   ```

2. `PUBLIC_WIDGET_ORIGIN` in `.env.local` must be the origin the widget is served from
   (`http://localhost:5174` here). The gateway allows cross-origin widget calls only from that
   origin, so restart `pnpm api` after changing it.

3. Add the loader to any page on a website in the brand's `allowedOrigins`
   (`http://localhost:8080` in the example above):

   ```html
   <script src="http://localhost:5174/loader.js" data-widget-id="wid_..."
           data-api="http://localhost:4000" async></script>
   ```

   For example, save that line as `index.html` in an empty folder and run
   `python3 -m http.server 8080` there.

Open the page and click the chat button. The widget opens, and you can send a message, get the AI
reply, ask for a person, and watch a staff reply from Chatwoot arrive live. Add
`data-locale="ur"` or `"ar"` for right to left. The loader options and the JavaScript API are
in `packages/widget-loader/README.md`. To build your own chat UI instead, see
`packages/client/README.md`.

On a server, serve `apps/widget/dist` (with `loader.js` copied in) as static files behind your TLS
proxy (for example `https://chat.example.com`). Set `PUBLIC_WIDGET_ORIGIN` to that origin, and
list each customer website in the brand's `allowedOrigins`.

## 5. Run the checks

```bash
pnpm ci:local                   # everything; about 8–12 minutes
pnpm ci:local --quick           # lint, typecheck, unit tests, status and licence checks
pnpm ci:local --skip-a11y       # everything except the Storybook accessibility audit
pnpm ci:local --skip-chatwoot   # everything except the real-Chatwoot contract suite
pnpm ci:local --skip-e2e        # everything except the widget journey in a browser
PG_VERSIONS=18 pnpm ci:local
```

Integration tests run in throwaway containers with fresh random passwords, so your development data
is never touched:

- PostgreSQL 16 and 18 with Valkey, for the database and gateway tests.
- A complete Chatwoot v4.18.0-ce on a random port, for the contract suite. The checks delete it
  afterwards, volumes included.
- A fresh PostgreSQL 18 and Valkey for the widget journey. It builds everything, then starts the
  gateway, the worker, a fake Chatwoot, the widget and a host page on another origin. Chromium
  then chats through it: AI reply, staff takeover, offline resend, right to left, an axe audit,
  and refusal on a website that is not allowed.

The summary is written to `test-results/ci-local.md`. Paste it into the pull request when you
review a change.

To run the quick checks automatically before every `git push`:

```bash
git config core.hooksPath .githooks
```

## 6. Look at the design system

```bash
pnpm --filter @hamnivo/brand build
pnpm --filter @hamnivo/ui storybook          # http://localhost:6006
# or build a static copy and serve it with any web server:
pnpm --filter @hamnivo/ui build-storybook    # output: packages/ui/storybook-static/
```

## 7. Updating

```bash
git pull
pnpm install
bash scripts/setup/env.sh   # adds any new secrets without touching existing ones
pnpm services:up            # also re-applies database roles
pnpm db:migrate
pnpm ci:local
```

## Coming with the next milestones

- Production compose file (with the vertical slice, M6). Adds `deploy/compose/hamnivo.yml` with the
  API, the background worker, Chatwoot and Caddy for automatic HTTPS. DNS needs `api.`, `app.`,
  `chat.` and `support.` (Chatwoot) records pointing at the server.
- Studio and website (next rounds).
- Backups and restore drill (ops round). Nightly `pg_dump` for both databases, volume snapshots
  and a scripted restore test.
