# Running Hamnivo on your own server

Hamnivo has no hosted CI. You run every check and host every service yourself, with the scripts in
this repository. This guide grows with the product. Each milestone adds its services and steps here.

## What you can run today

| Part | Status | How |
|---|---|---|
| Checks (lint, types, unit, integration on PostgreSQL 16 and 18, accessibility) | ready | `pnpm ci:local` |
| Infrastructure (PostgreSQL 18 + pgvector, Valkey) | ready | `pnpm services:up` |
| Design system (Storybook) | ready | `pnpm --filter @hamnivo/ui storybook` |
| Database schema, row-level security and audit log | ready | `pnpm db:migrate` |
| Gateway, worker, widget, Studio, website, Chatwoot | not yet built | added by later milestones, with a production compose file and TLS proxy |

## 1. Server requirements

- **OS:** Ubuntu 24.04 LTS or any recent Linux with Docker. macOS works for development.
- **Checks and development:** 2 vCPU, 4 GB RAM, 20 GB free disk.
- **Full stack with Chatwoot, later:** 4 vCPU, 8 GB RAM, 40 GB SSD, and a domain name you control.

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

## 5. Run the checks

```bash
pnpm ci:local               # everything; about 5–10 minutes
pnpm ci:local --quick       # lint, typecheck, unit tests, status and licence checks
pnpm ci:local --skip-a11y   # everything except the Storybook accessibility audit
PG_VERSIONS=18 pnpm ci:local
```

Integration tests run in throwaway PostgreSQL 16/18 and Valkey containers with fresh random
passwords, so your development data is never touched. The summary is written to
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

- Gateway and worker (M4). Adds `deploy/compose/hamnivo.yml` with the API, the background worker
  and Caddy for automatic HTTPS. DNS needs `api.`, `app.` and `chat.` records pointing at the server.
- Chatwoot CE v4.18.0 (M5). Runs in the same compose project with its own database, plus a
  bootstrap script for the super admin and the platform token.
- Widget, Studio and website (M6 onward).
- Backups and restore drill (ops round). Nightly `pg_dump` for both databases, volume snapshots
  and a scripted restore test.
