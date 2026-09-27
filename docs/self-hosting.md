# Running Hamnivo on your own server

Hamnivo has no hosted CI. You run every check and host every service yourself, with the scripts in
this repository. This guide grows with the product. Each milestone adds its services and steps here.

## What you can run today

| Part | Status | How |
|---|---|---|
| Checks (lint, types, unit, integration on PostgreSQL 16 and 18, Chatwoot contract, accessibility) | ready | `pnpm ci:local` |
| Infrastructure (PostgreSQL 18 + pgvector, Valkey) | ready | `pnpm services:up` |
| Design system (Storybook) | ready | `pnpm --filter @hamnivo/ui storybook` |
| Database schema, row-level security and audit log | ready | `pnpm db:migrate` |
| Gateway API (staff sign-in, tenants, members, roles, grants, secrets, audit) and worker | ready | `pnpm api`, `pnpm worker` |
| Chatwoot CE v4.18.0 (conversation authority) with the Hamnivo Platform App | ready | `pnpm chatwoot:up` |
| Widget, Studio, website | not yet built | added by later milestones, with a production compose file and TLS proxy |

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

# Browser for the accessibility audit (installs Chromium and its system libraries)
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

## 5. Run the checks

```bash
pnpm ci:local                   # everything; about 8–12 minutes
pnpm ci:local --quick           # lint, typecheck, unit tests, status and licence checks
pnpm ci:local --skip-a11y       # everything except the Storybook accessibility audit
pnpm ci:local --skip-chatwoot   # everything except the real-Chatwoot contract suite
PG_VERSIONS=18 pnpm ci:local
```

Integration tests run in throwaway containers with fresh random passwords, so your development data
is never touched:

- PostgreSQL 16 and 18 with Valkey, for the database and gateway tests.
- A complete Chatwoot v4.18.0-ce on a random port, for the contract suite. The checks delete it
  afterwards, volumes included. The summary is written to
`test-results/ci-local.md`. Paste it into the pull request when you review a change.

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
- Widget, Studio and website (M6 onward).
- Backups and restore drill (ops round). Nightly `pg_dump` for both databases, volume snapshots
  and a scripted restore test.
